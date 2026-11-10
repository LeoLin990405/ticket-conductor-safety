/**
 * Adapter-independent store logic (WP1).
 *
 * The high-level functions in this module implement the contract from
 * docs/TASKS.md exactly once. Both `memoryAdapter.js` and `forgeAdapter.js`
 * provide the same small persistence backend, so unit tests exercise the same
 * validation, defaults, optimistic-update, and query semantics that run in
 * production.
 *
 * Backend contract (internal, not part of the public WP1 API):
 *   get(entityName, key) -> Promise<{id, record}|null>
 *   set(entityName, key, record) -> Promise<void>
 *   putIfAbsent(entityName, key, record) -> Promise<boolean>
 *   updateIfMatch(entityName, key, record, field, expected) -> Promise<boolean>
 *   query(entityName, indexName, options) -> Promise<Array<{id, record}>>
 *
 * @module store/storeCore
 */

import { randomUUID } from 'node:crypto';

import {
  ConflictError,
  NotFoundError,
  StoreValidationError,
  ValueTooLargeError,
} from './errors.js';
import { applyRunBudget, countAddedWorkSteps, initialRunBudget } from '../run/budget.js';
import {
  EFFECT_KINDS,
  EFFECT_STATUSES,
  EVENT_KINDS,
  MAX_VALUE_BYTES,
  MEMORY_SCOPES,
  MEMORY_TYPES,
  RUN_STATUSES,
  STEP_STATUSES,
  STUCK_QUEUED_MS,
} from './types.js';

const RUN_ENTITY = 'run';
const STEP_ENTITY = 'step';
const EFFECT_ENTITY = 'effect';
const MEMORY_ENTITY = 'memory';
const EVENT_ENTITY = 'event';

const textEncoder = new TextEncoder();

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{optional?: boolean, allowEmpty?: boolean}} [options]
 * @returns {string|undefined}
 */
function assertString(value, field, options = {}) {
  const { optional = false, allowEmpty = false } = options;
  if (value === undefined || value === null) {
    if (optional) {
      return undefined;
    }
    throw new StoreValidationError(`${field} is required`);
  }
  if (typeof value !== 'string') {
    throw new StoreValidationError(`${field} must be a string`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new StoreValidationError(`${field} must not be empty`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{optional?: boolean}} [options]
 * @returns {number|undefined}
 */
function assertNumber(value, field, options = {}) {
  const { optional = false } = options;
  if (value === undefined || value === null) {
    if (optional) {
      return undefined;
    }
    throw new StoreValidationError(`${field} is required`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new StoreValidationError(`${field} must be a finite number`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{optional?: boolean, min?: number}} [options]
 * @returns {number|undefined}
 */
function assertInteger(value, field, options = {}) {
  const { optional = false, min = Number.MIN_SAFE_INTEGER } = options;
  const number = assertNumber(value, field, { optional });
  if (number === undefined) {
    return undefined;
  }
  if (!Number.isInteger(number) || number < min) {
    throw new StoreValidationError(
      `${field} must be an integer greater than or equal to ${min}`,
    );
  }
  return number;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {ReadonlyArray<string>} allowed
 * @returns {string}
 */
function assertEnum(value, field, allowed) {
  const text = assertString(value, field);
  if (!allowed.includes(text)) {
    throw new StoreValidationError(
      `${field} must be one of ${allowed.join(', ')}; received ${text}`,
    );
  }
  return text;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {Record<string, unknown>}
 */
function assertPlainObject(value, field) {
  if (value === undefined || value === null || typeof value !== 'object') {
    throw new StoreValidationError(`${field} must be an object`);
  }
  if (Array.isArray(value)) {
    throw new StoreValidationError(`${field} must be an object, not an array`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * Remove keys whose value is undefined. Forge string attributes cannot be
 * empty, so callers use `undefined` in a patch to drop an optional field.
 *
 * @param {Record<string, unknown>} record
 * @returns {Record<string, unknown>}
 */
/** Newest memory rows read per project list. */
export const MEMORY_LIST_CAP = 50;
/** One run's planning reads the list several times within this window. */
export const MEMORY_CACHE_MS = 60 * 1000;
/** Longest string kept in an event payload, in characters. */
export const EVENT_TEXT_MAX = 400;

/**
 * Event payloads are a flight log, not an archive: model output already lives
 * in the step row and the Jira comment. Clip long strings and long arrays so
 * each event write stays small.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function trimEventDetail(value, depth = 0) {
  if (typeof value === 'string') {
    return value.length > EVENT_TEXT_MAX ? `${value.slice(0, EVENT_TEXT_MAX - 1)}\u2026` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => trimEventDetail(item, depth + 1));
  }
  if (value && typeof value === 'object' && depth < 6) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = trimEventDetail(item, depth + 1);
    }
    return out;
  }
  return value;
}

function cleanRecord(record) {
  /** @type {Record<string, unknown>} */
  const cleaned = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

/**
 * Measure a single value using the same rule the 64 KiB cap documents:
 * UTF-8 bytes for strings, JSON bytes for objects/arrays.
 *
 * @param {string} entityName
 * @param {string} field
 * @param {unknown} value
 * @returns {number}
 */
function measureValue(entityName, field, value) {
  if (value === undefined) {
    return 0;
  }
  let json;
  if (typeof value === 'string') {
    return textEncoder.encode(value).length;
  }
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new StoreValidationError(
      `${entityName}.${field} is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (json === undefined) {
    throw new StoreValidationError(
      `${entityName}.${field} is not JSON-serializable`,
    );
  }
  return textEncoder.encode(json).length;
}

/**
 * Enforce the app-level 64 KiB cap on every field of a record.
 *
 * @param {string} entityName
 * @param {Record<string, unknown>} record
 * @returns {void}
 */
function validateValueSizes(entityName, record) {
  for (const [field, value] of Object.entries(record)) {
    const bytes = measureValue(entityName, field, value);
    if (bytes > MAX_VALUE_BYTES) {
      throw new ValueTooLargeError(entityName, field, bytes);
    }
  }
}

/**
 * @param {Record<string, unknown>} record
 * @returns {void}
 */
function validateRunRecord(record) {
  assertString(record.epicKey, 'run.epicKey');
  assertString(record.projectKey, 'run.projectKey');
  assertString(record.goal, 'run.goal');
  assertEnum(record.status, 'run.status', RUN_STATUSES);
  assertString(record.createdBy, 'run.createdBy');
  assertNumber(record.createdAt, 'run.createdAt');
  assertNumber(record.updatedAt, 'run.updatedAt');
  // Fork linkage is optional. Absent on every run that was not forked.
  assertString(record.forkedFromRunId, 'run.forkedFromRunId', { optional: true });
  assertInteger(record.forkedFromStepIdx, 'run.forkedFromStepIdx', {
    optional: true,
    min: 0,
  });
  assertInteger(record.forkSeq, 'run.forkSeq', { optional: true, min: 0 });
  // Integer claim for the lead loop. Optional so a row written before the
  // field existed still loads. Never a float, and never the entity key.
  assertInteger(record.reviewedThroughWave, 'run.reviewedThroughWave', {
    optional: true,
    min: 0,
  });
  if (record.ledger !== undefined) {
    assertPlainObject(record.ledger, 'run.ledger');
  }
  // Optional so a row written before the budget attribute existed still loads.
  // New runs always store it. The shape is one `any` value, not eight attributes.
  if (record.budget !== undefined) {
    validateRunBudget(record.budget);
  }
  // Optional. Absent until a panel grant is shared. A normal run omits it.
  if (record.grants !== undefined) {
    validateRunGrants(record.grants);
  }
}

/**
 * Used-grant rows on `run.grants`. The token itself is not stored.
 * One object, capped at 16 entries, so a replay can be seen from any
 * instance that reads this run.
 *
 * @param {unknown} value
 * @returns {void}
 */
function validateRunGrants(value) {
  const grants = assertPlainObject(value, 'run.grants');
  const ids = Object.keys(grants);
  if (ids.length > 16) {
    throw new StoreValidationError('run.grants exceeds 16 entries');
  }
  const allowed = new Set([
    'kind',
    'binding',
    'acknowledgement',
    'expiresAt',
    'used',
    'principal',
  ]);
  for (const id of ids) {
    if (!/^[0-9a-f]{32}$/.test(id)) {
      throw new StoreValidationError('run.grants key must be a grant id');
    }
    const row = assertPlainObject(grants[id], `run.grants.${id}`);
    for (const key of Object.keys(row)) {
      if (!allowed.has(key)) {
        throw new StoreValidationError(`run.grants.${id}.${key} is not a grant field`);
      }
    }
    assertEnum(row.kind, `run.grants.${id}.kind`, ['dispatch', 'fork']);
    const binding = assertString(row.binding, `run.grants.${id}.binding`);
    if (binding.length > 8_000) {
      throw new StoreValidationError(`run.grants.${id}.binding is too long`);
    }
    const acknowledgement = assertString(row.acknowledgement, `run.grants.${id}.acknowledgement`);
    if (acknowledgement.length > 500) {
      throw new StoreValidationError(`run.grants.${id}.acknowledgement is too long`);
    }
    assertNumber(row.expiresAt, `run.grants.${id}.expiresAt`);
    if (typeof row.used !== 'boolean') {
      throw new StoreValidationError(`run.grants.${id}.used must be a boolean`);
    }
    const principal = assertString(row.principal, `run.grants.${id}.principal`, { allowEmpty: true });
    if (principal.length > 128) {
      throw new StoreValidationError(`run.grants.${id}.principal is too long`);
    }
  }
}

/**
 * Caps and counters stored on `run.budget`. Integers only, so a later
 * compare-and-swap would not need a float condition. This slice does not
 * compare-and-swap the budget; it is rewritten with the rest of the row.
 * `chaos`, when present, is three more integers on that same object.
 *
 * @param {unknown} value
 * @returns {void}
 */
function validateRunBudget(value) {
  const budget = assertPlainObject(value, 'run.budget');
  for (const field of [
    'maxSteps',
    'maxModelCalls',
    'wallClockMs',
    'usedSteps',
    'usedModelCalls',
    'usedTokens',
    'elapsedMs',
    'startedAt',
  ]) {
    assertInteger(budget[field], `run.budget.${field}`, { min: 0 });
  }
  // Optional. A run that has not fired a fault omits `chaos`, so the stored
  // row is the same size as before this object existed. When it is present
  // it is the three proof counters and nothing else.
  if (budget.chaos !== undefined) {
    const chaos = assertPlainObject(budget.chaos, 'run.budget.chaos');
    const allowed = new Set(['injected', 'healed', 'duplicateWrites']);
    for (const key of Object.keys(chaos)) {
      if (!allowed.has(key)) {
        throw new StoreValidationError(`run.budget.chaos.${key} is not a chaos counter`);
      }
    }
    for (const field of allowed) {
      assertInteger(chaos[field], `run.budget.chaos.${field}`, { min: 0 });
    }
  }
  // Optional. Omitted until a dedupe tally piggybacks on a budget write.
  // `applied` and `retried` are not stored; they are counted from effect rows.
  if (budget.effects !== undefined) {
    const effects = assertPlainObject(budget.effects, 'run.budget.effects');
    const allowed = new Set(['deduped']);
    for (const key of Object.keys(effects)) {
      if (!allowed.has(key)) {
        throw new StoreValidationError(`run.budget.effects.${key} is not an effect counter`);
      }
    }
    assertInteger(effects.deduped, 'run.budget.effects.deduped', { min: 0 });
  }
}

/**
 * @param {Record<string, unknown>} record
 * @returns {void}
 */
function validateStepRecord(record) {
  assertString(record.runId, 'step.runId');
  assertInteger(record.idx, 'step.idx', { min: 0 });
  assertString(record.title, 'step.title');
  assertString(record.workerType, 'step.workerType');
  assertEnum(record.status, 'step.status', STEP_STATUSES);
  assertInteger(record.attempt, 'step.attempt', { min: 0 });
  assertNumber(record.createdAt, 'step.createdAt');
  assertString(record.childIssueKey, 'step.childIssueKey', { optional: true });
  assertNumber(record.deadlineAt, 'step.deadlineAt', { optional: true });
  // Magentic-One stall counter. Integer, so a later compare-and-set would not
  // need a condition on a float. The watchdog increments it; replay never does.
  assertInteger(record.stallCount, 'step.stallCount', { optional: true, min: 0 });
  // Wave number. Optional on rows created before the lead loop. New rows
  // always store it. It is not the entity key (`stepId`).
  assertInteger(record.wave, 'step.wave', { optional: true, min: 1 });
  // WP15. Both are optional so rows written before the brief existed still
  // load. `skill` is never the entity key (`stepId`); do not add stepId here.
  assertString(record.skill, 'step.skill', { optional: true });
  if (record.brief !== undefined) {
    readBrief(record.brief, 'step.brief');
  }
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number[]}
 */
function briefDependsOn(value, field) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new StoreValidationError(
      `${field}.dependsOn must be an array of step indexes`,
    );
  }
  return value.map((entry, position) => {
    if (!Number.isInteger(entry) || entry < 0) {
      throw new StoreValidationError(
        `${field}.dependsOn[${position}] must be a non-negative integer step index`,
      );
    }
    return entry;
  });
}

/**
 * The sub-agent brief stored on a step (WP15). One object, four fields.
 * Forge stores it as a single `any` attribute named `brief`.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {Record<string, unknown>}
 */
function readBrief(value, field) {
  const brief = assertPlainObject(value, field);
  const objective = assertString(brief.objective, `${field}.objective`);
  if (
    !Array.isArray(brief.allowedTools) ||
    brief.allowedTools.some((tool) => typeof tool !== 'string')
  ) {
    throw new StoreValidationError(
      `${field}.allowedTools must be an array of strings`,
    );
  }
  const doneWhen = assertString(brief.doneWhen, `${field}.doneWhen`);
  const budget = assertPlainObject(brief.budget, `${field}.budget`);
  const stored = {
    objective,
    allowedTools: brief.allowedTools.map(String),
    doneWhen,
    budget: {
      maxToolCalls: assertInteger(budget.maxToolCalls, `${field}.budget.maxToolCalls`, { min: 0 }),
      maxOutputBytes: assertInteger(budget.maxOutputBytes, `${field}.budget.maxOutputBytes`, { min: 1 }),
      maxRepairAttempts: assertInteger(
        budget.maxRepairAttempts,
        `${field}.budget.maxRepairAttempts`,
        { min: 0 },
      ),
    },
    // Missing means `[]` so a brief written before this field existed still loads.
    dependsOn: briefDependsOn(brief.dependsOn, field),
  };
  if (typeof brief.upstream === 'string' && brief.upstream.length > 0) {
    stored.upstream = brief.upstream;
  }
  return stored;
}

/**
 * @param {Record<string, unknown>} record
 * @returns {void}
 */
function validateEffectRecord(record) {
  assertString(record.runId, 'effect.runId', { optional: true });
  assertString(record.stepId, 'effect.stepId', { optional: true });
  assertEnum(record.kind, 'effect.kind', EFFECT_KINDS);
  assertEnum(record.status, 'effect.status', EFFECT_STATUSES);
  assertInteger(record.tries, 'effect.tries', { min: 0 });
  assertNumber(record.updatedAt, 'effect.updatedAt');
  assertNumber(record.appliedAt, 'effect.appliedAt', { optional: true });
}

/**
 * @param {Record<string, unknown>} record
 * @returns {void}
 */
function validateMemoryRecord(record) {
  assertString(record.projectKey, 'memory.projectKey');
  assertEnum(record.scope, 'memory.scope', MEMORY_SCOPES);
  assertEnum(record.memType, 'memory.memType', MEMORY_TYPES);
  assertString(record.text, 'memory.text');
  assertNumber(record.createdAt, 'memory.createdAt');
  assertNumber(record.validUntil, 'memory.validUntil');
  assertString(record.sourceIssue, 'memory.sourceIssue', { optional: true });
  assertString(record.runId, 'memory.runId', { optional: true });
  assertString(record.supersededBy, 'memory.supersededBy', { optional: true });
}

/**
 * Apply a partial patch to an existing record.
 *
 * `undefined` removes an optional field. Identity fields are protected: a
 * patch may repeat the current value but cannot change it.
 *
 * @param {Record<string, unknown>} existing
 * @param {Record<string, unknown>} patch
 * @param {ReadonlyArray<string>} protectedFields
 * @param {string} entityName
 * @returns {Record<string, unknown>}
 */
function applyPatch(existing, patch, protectedFields, entityName) {
  assertPlainObject(patch, `${entityName} patch`);
  const next = { ...existing };
  for (const [field, value] of Object.entries(patch)) {
    if (protectedFields.includes(field)) {
      if (value !== undefined && value !== existing[field]) {
        throw new StoreValidationError(
          `${entityName}.${field} is immutable and cannot be patched`,
        );
      }
      continue;
    }
    if (value === undefined) {
      delete next[field];
    } else {
      next[field] = value;
    }
  }
  return cleanRecord(next);
}

/**
 * Return a timestamp strictly newer than the previous one. Two updates in the
 * same millisecond still produce distinct `updatedAt` values, which keeps
 * optimistic locking meaningful.
 *
 * @param {number|undefined} previous
 * @param {() => number} clock
 * @returns {number}
 */
function nextTimestamp(previous, clock) {
  const now = clock();
  return Number.isFinite(previous) ? Math.max(now, previous + 1) : now;
}

/**
 * @param {unknown} options
 * @param {string} operation
 * @returns {number|undefined}
 */
function readLimit(options, operation) {
  if (options === undefined || options === null) {
    return undefined;
  }
  assertPlainObject(options, `${operation} options`);
  const limit = /** @type {{limit?: unknown}} */ (options).limit;
  if (limit === undefined) {
    return undefined;
  }
  return assertInteger(limit, `${operation} limit`, { min: 0 });
}

/**
 * @param {string} idField
 * @param {{id: string, record: Record<string, unknown>}} row
 * @returns {Record<string, unknown>}
 */
function withId(idField, row) {
  return { ...row.record, [idField]: row.id };
}

/**
 * Create the complete WP1 store on top of a persistence backend.
 *
 * @param {object} backend Persistence backend (memory or Forge).
 * @param {import('./types.js').StoreOptions} [options] Clock/id injection.
 * @returns {import('./types.js').Store}
 */
export function createStoreFromBackend(backend, options = {}) {
  if (!backend || typeof backend !== 'object') {
    throw new StoreValidationError('backend is required');
  }
  const required = ['get', 'set', 'putIfAbsent', 'updateIfMatch', 'query'];
  for (const method of required) {
    if (typeof backend[method] !== 'function') {
      throw new StoreValidationError(
        `backend.${method} must be a function`,
      );
    }
  }

  const clock = options.now ?? (() => Date.now());
  // Per-instance caches that save KVS reads. See listMemoriesByProject and
  // nextEventSeq.
  /** @type {Map<string, {at: number, rows: any[]}>} */
  const memoryListCache = new Map();
  /** @type {Map<string, number>} */
  const eventSeqCache = new Map();
  const newId = options.newId ?? (() => randomUUID());

  /**
   * @param {import('./types.js').CreateRunInput} input
   * @returns {Promise<import('./types.js').Run>}
   */
  async function createRun(input) {
    const source = assertPlainObject(input, 'createRun input');
    const timestamp = clock();
    const record = cleanRecord({
      epicKey: assertString(source.epicKey, 'run.epicKey'),
      projectKey: assertString(source.projectKey, 'run.projectKey'),
      goal: assertString(source.goal, 'run.goal'),
      status: 'planning',
      createdBy: assertString(source.createdBy, 'run.createdBy'),
      createdAt: timestamp,
      updatedAt: timestamp,
      // Present only on a fork. Omitted otherwise so existing rows stay unchanged.
      forkedFromRunId: assertString(
        source.forkedFromRunId,
        'run.forkedFromRunId',
        { optional: true },
      ),
      forkedFromStepIdx: assertInteger(
        source.forkedFromStepIdx,
        'run.forkedFromStepIdx',
        { optional: true, min: 0 },
      ),
      forkSeq: assertInteger(source.forkSeq, 'run.forkSeq', {
        optional: true,
        min: 0,
      }),
      // 0 until the lead reviews wave 1. An integer so the review can
      // compare-and-swap without a float condition.
      reviewedThroughWave: 0,
      // Caps plus zero usage. The panel reads this object later. It is not
      // a critical-path ETA, and going over a cap does not change status.
      budget: initialRunBudget(timestamp),
    });
    validateRunRecord(record);
    validateValueSizes(RUN_ENTITY, record);

    const runId = newId();
    await backend.set(RUN_ENTITY, runId, record);
    return /** @type {import('./types.js').Run} */ ({ runId, ...record });
  }

  /**
   * @param {string} runId
   * @returns {Promise<import('./types.js').Run|null>}
   */
  async function getRun(runId) {
    assertString(runId, 'runId');
    const row = await backend.get(RUN_ENTITY, runId);
    return row
      ? /** @type {import('./types.js').Run} */ (withId('runId', row))
      : null;
  }

  /**
   * @param {string} epicKey
   * @param {import('./types.js').ListOptions} [listOptions]
   * @returns {Promise<import('./types.js').Run[]>}
   */
  async function listRunsByEpic(epicKey, listOptions) {
    assertString(epicKey, 'epicKey');
    const limit = readLimit(listOptions, 'listRunsByEpic');
    if (limit === 0) {
      return [];
    }
    const rows = await backend.query(RUN_ENTITY, 'by-epic', {
      partition: [epicKey],
      range: { op: 'gte', value: 0 },
      direction: 'DESC',
      limit,
    });
    return rows.map((row) => /** @type {import('./types.js').Run} */ (withId('runId', row)));
  }

  /**
   * @param {string} runId
   * @param {Partial<import('./types.js').Run>} patch
   * @param {import('./types.js').UpdateRunOptions} [updateOptions]
   * @returns {Promise<import('./types.js').Run>}
   */
  async function updateRun(runId, patch, updateOptions) {
    assertString(runId, 'runId');
    const options = updateOptions === undefined || updateOptions === null
      ? {}
      : assertPlainObject(updateOptions, 'updateRun options');
    const expectedUpdatedAt = assertNumber(
      options.expectedUpdatedAt,
      'updateRun expectedUpdatedAt',
      { optional: true },
    );
    // Integer claim. `0` is a real value (no wave reviewed yet), so a missing
    // option stays `undefined` and is not coerced to 0.
    const expectedReviewedWave = assertInteger(
      options.expectedReviewedWave,
      'updateRun expectedReviewedWave',
      { optional: true, min: 0 },
    );
    const expectedStatus = options.expectedStatus === undefined
      ? undefined
      : assertEnum(options.expectedStatus, 'updateRun expectedStatus', RUN_STATUSES);
    const claimCount = [expectedUpdatedAt, expectedReviewedWave, expectedStatus]
      .filter((value) => value !== undefined)
      .length;
    if (claimCount > 1) {
      throw new StoreValidationError(
        'updateRun compare-and-swap accepts one field: updatedAt, reviewedThroughWave, or status',
      );
    }

    const existing = await getRun(runId);
    if (!existing) {
      throw new NotFoundError(RUN_ENTITY, runId);
    }
    if (
      expectedUpdatedAt !== undefined &&
      existing.updatedAt !== expectedUpdatedAt
    ) {
      throw new ConflictError(
        RUN_ENTITY,
        runId,
        expectedUpdatedAt,
        existing.updatedAt,
      );
    }
    // A lost integer or string claim returns null. Callers retry or stop.
    // The condition is not `updatedAt`: Forge has rejected float equality.
    if (
      expectedReviewedWave !== undefined &&
      existing.reviewedThroughWave !== expectedReviewedWave
    ) {
      return null;
    }
    if (expectedStatus !== undefined && existing.status !== expectedStatus) {
      return null;
    }

    const merged = applyPatch(
      /** @type {Record<string, unknown>} */ (existing),
      patch,
      ['runId', 'createdAt', 'forkedFromRunId', 'forkedFromStepIdx', 'forkSeq'],
      RUN_ENTITY,
    );
    merged.updatedAt = nextTimestamp(existing.updatedAt, clock);
    validateRunRecord(merged);
    validateValueSizes(RUN_ENTITY, merged);

    if (expectedReviewedWave !== undefined) {
      const updated = await backend.updateIfMatch(
        RUN_ENTITY,
        runId,
        merged,
        'reviewedThroughWave',
        expectedReviewedWave,
      );
      return updated ? /** @type {import('./types.js').Run} */ (merged) : null;
    }
    if (expectedStatus !== undefined) {
      const updated = await backend.updateIfMatch(
        RUN_ENTITY,
        runId,
        merged,
        'status',
        expectedStatus,
      );
      return updated ? /** @type {import('./types.js').Run} */ (merged) : null;
    }

    if (expectedUpdatedAt === undefined) {
      await backend.set(RUN_ENTITY, runId, merged);
      return /** @type {import('./types.js').Run} */ (merged);
    }

    const updated = await backend.updateIfMatch(
      RUN_ENTITY,
      runId,
      merged,
      'updatedAt',
      expectedUpdatedAt,
    );
    if (!updated) {
      const current = await getRun(runId);
      throw new ConflictError(
        RUN_ENTITY,
        runId,
        expectedUpdatedAt,
        current?.updatedAt ?? null,
      );
    }
    return /** @type {import('./types.js').Run} */ (merged);
  }

  /**
   * @param {string} runId
   * @param {import('./types.js').StepDraft[]} steps
   * @returns {Promise<import('./types.js').Step[]>}
   */
  async function createSteps(runId, steps, createOptions = {}) {
    // `stepIds` gives fixed ids. A fixed id is written with putIfAbsent, so
    // concurrent callers create it once; a step that already exists is left
    // out of the result.
    const fixedIds = Array.isArray(createOptions?.stepIds)
      ? createOptions.stepIds
      : null;
    assertString(runId, 'runId');
    if (!Array.isArray(steps)) {
      throw new StoreValidationError('createSteps steps must be an array');
    }

    const timestamp = clock();
    // Idx is the step's position in the whole run, not just in this call.
    // `recomputeRunStatus` appends the summarize step with a second
    // createSteps. Restarting at 0 would give that step the same idx as the
    // first planned step. The panel and the demo hang both identify a step
    // by idx, so the collision hides the real step 0 and can hang summarize.
    let startIdx = 0;
    if (steps.length > 0) {
      const newest = await backend.query(STEP_ENTITY, 'by-run', {
        partition: [runId],
        range: { op: 'gte', value: 0 },
        direction: 'DESC',
        limit: 1,
      });
      if (newest.length > 0) {
        startIdx = Number(newest[0].record.idx) + 1;
      }
    }
    const prepared = steps.map((draft, offset) => {
      const source = assertPlainObject(draft, `steps[${offset}]`);
      const record = cleanRecord({
        runId,
        idx: startIdx + offset,
        title: assertString(source.title, `steps[${offset}].title`),
        workerType: assertString(
          source.workerType,
          `steps[${offset}].workerType`,
        ),
        input: source.input,
        // Always store the list, including `[]`, so a later read can tell
        // "no dependencies" from a row written before this field existed.
        // Old rows simply omit it; readers treat that as `[]`.
        dependsOn: readDependsOn(source.dependsOn, `steps[${offset}]`),
        // Always store the wave. A draft that omits it is wave 1 (the plan).
        // The lead passes 2 or 3 when it spawns the next wave.
        wave: readWave(source.wave, `steps[${offset}].wave`),
        skill: source.skill === undefined
          ? undefined
          : assertString(source.skill, `steps[${offset}].skill`),
        brief: source.brief === undefined
          ? undefined
          : readBrief(source.brief, `steps[${offset}].brief`),
        status: 'queued',
        attempt: 0,
        createdAt: timestamp,
      });
      validateStepRecord(record);
      validateValueSizes(STEP_ENTITY, record);
      return record;
    });

    const created = await Promise.all(
      prepared.map(async (record, offset) => {
        const fixed = fixedIds?.[offset];
        if (typeof fixed === 'string' && fixed.length > 0) {
          const wrote = await backend.putIfAbsent(STEP_ENTITY, fixed, record);
          return wrote
            ? /** @type {import('./types.js').Step} */ ({ stepId: fixed, ...record })
            : null;
        }
        const stepId = newId();
        await backend.set(STEP_ENTITY, stepId, record);
        return /** @type {import('./types.js').Step} */ ({ stepId, ...record });
      }),
    );
    const stored = created.filter(Boolean);
    // One write for the whole batch, and only when a work step was added.
    // Summarize does not count, so the closer does not touch the run again.
    // A duplicate `putIfAbsent` returns null and is already filtered out.
    const added = countAddedWorkSteps(stored);
    if (added > 0) {
      const run = await getRun(runId);
      if (run) {
        await updateRun(runId, {
          budget: applyRunBudget(run.budget, {
            steps: added,
            now: clock(),
            startedAt: run.createdAt,
          }),
        });
      }
    }
    return stored;
  }

  /**
   * @param {string} stepId
   * @returns {Promise<import('./types.js').Step|null>}
   */
  async function getStep(stepId) {
    assertString(stepId, 'stepId');
    const row = await backend.get(STEP_ENTITY, stepId);
    return row
      ? /** @type {import('./types.js').Step} */ (withId('stepId', row))
      : null;
  }

  /**
   * @param {string} runId
   * @returns {Promise<import('./types.js').Step[]>}
   */
  async function listSteps(runId) {
    assertString(runId, 'runId');
    const rows = await backend.query(STEP_ENTITY, 'by-run', {
      partition: [runId],
      range: { op: 'gte', value: 0 },
      direction: 'ASC',
    });
    return rows.map((row) => /** @type {import('./types.js').Step} */ (withId('stepId', row)));
  }

  /**
   * Persist `dependsOn` as a list of step indexes.
   *
   * The plan-level checks (range, self-reference, cycles) live in
   * `src/run/graph.js` and run before dispatch. Here we only refuse a value
   * that is not a list of integers, so a bad shape never reaches the entity.
   * Indexes may point at a step created in an earlier `createSteps` call
   * (the summarize step is appended that way), so this function does not
   * check that the target exists.
   *
   * @param {unknown} value
   * @param {string} field
   * @returns {number[]}
   */
  /**
   * Wave number for a new step. Omitted means wave 1.
   *
   * @param {unknown} value
   * @param {string} field
   * @returns {number}
   */
  function readWave(value, field) {
    if (value === undefined || value === null) {
      return 1;
    }
    return assertInteger(value, field, { min: 1 });
  }

  function readDependsOn(value, field) {
    if (value === undefined || value === null) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new StoreValidationError(
        `${field}.dependsOn must be an array of step indexes`,
      );
    }
    return value.map((entry, position) => {
      if (!Number.isInteger(entry) || entry < 0) {
        throw new StoreValidationError(
          `${field}.dependsOn[${position}] must be a non-negative integer step index`,
        );
      }
      return entry;
    });
  }

  /**
   * @param {string} stepId
   * @param {Partial<import('./types.js').Step>} patch
   * @param {{expectedStatus?: import('./types.js').StepStatus}} [updateOptions]
   * @returns {Promise<import('./types.js').Step|null>}
   */
  async function updateStep(stepId, patch, updateOptions) {
    assertString(stepId, 'stepId');
    const expectedStatus =
      updateOptions === undefined || updateOptions === null
        ? undefined
        : updateOptions.expectedStatus;
    if (
      expectedStatus !== undefined &&
      !STEP_STATUSES.includes(expectedStatus)
    ) {
      throw new StoreValidationError(
        `updateStep expectedStatus must be one of ${STEP_STATUSES.join(', ')}`,
      );
    }
    // Compare-and-swap on `status` (a string). Two writers patch steps
    // concurrently: the worker (running -> done, with output) and the effect
    // applier (records childIssueKey). A blind read-modify-write let the
    // applier's stale `running` snapshot overwrite the worker's `done`,
    // leaving the step stuck in `running` with no output (run 712a7626).
    // On a lost race, re-read and re-apply the patch on top of the newer
    // record. The condition is the string `status`, not a float timestamp:
    // Forge has rejected equality conditions on float attributes with a 422.
    //
    // `expectedStatus` is optional. When it is set and the row is no longer
    // in that status, return null and do not write. Callers that release a
    // `waiting` step use this so a second invocation cannot put a finished
    // step back to `queued`.
    for (let tries = 0; tries < 6; tries += 1) {
      const existing = await getStep(stepId);
      if (!existing) {
        throw new NotFoundError(STEP_ENTITY, stepId);
      }
      if (expectedStatus !== undefined && existing.status !== expectedStatus) {
        return null;
      }

      const merged = applyPatch(
        /** @type {Record<string, unknown>} */ (existing),
        patch,
        ['stepId', 'runId', 'idx', 'createdAt', 'dependsOn'],
        STEP_ENTITY,
      );
      validateStepRecord(merged);
      validateValueSizes(STEP_ENTITY, merged);
      const ok = await backend.updateIfMatch(
        STEP_ENTITY,
        stepId,
        merged,
        'status',
        existing.status,
      );
      if (ok) {
        return /** @type {import('./types.js').Step} */ (merged);
      }
    }
    throw new Error(`updateStep ${stepId}: too many concurrent writes`);
  }

  /**
   * @param {number} [nowMs]
   * @returns {Promise<import('./types.js').Step[]>}
   */
  async function findStuckSteps(nowMs = clock()) {
    assertNumber(nowMs, 'nowMs');
    const [overdueRunning, overdueQueued] = await Promise.all([
      backend.query(STEP_ENTITY, 'by-status-deadline', {
        partition: ['running'],
        range: { op: 'lt', value: nowMs },
        direction: 'ASC',
      }),
      backend.query(STEP_ENTITY, 'by-status-created', {
        partition: ['queued'],
        range: { op: 'lt', value: nowMs - STUCK_QUEUED_MS },
        direction: 'ASC',
      }),
    ]);

    const seen = new Set();
    const stuck = [];
    for (const row of [...overdueRunning, ...overdueQueued]) {
      if (seen.has(row.id)) {
        continue;
      }
      seen.add(row.id);
      stuck.push(
        /** @type {import('./types.js').Step} */ (withId('stepId', row)),
      );
    }
    return stuck;
  }

  /**
   * @param {import('./types.js').EffectInput} effect
   * @returns {Promise<import('./types.js').PutEffectResult>}
   */
  async function putEffectIfAbsent(effect) {
    const source = assertPlainObject(effect, 'putEffectIfAbsent effect');
    const requestKey = assertString(source.requestKey, 'effect.requestKey');
    const timestamp = clock();
    const status =
      source.status === undefined
        ? 'pending'
        : assertEnum(source.status, 'effect.status', EFFECT_STATUSES);
    const record = cleanRecord({
      runId: assertString(source.runId, 'effect.runId', { optional: true }),
      stepId: assertString(source.stepId, 'effect.stepId', {
        optional: true,
      }),
      kind: assertEnum(source.kind, 'effect.kind', EFFECT_KINDS),
      payload: source.payload === undefined ? {} : source.payload,
      status,
      tries:
        source.tries === undefined
          ? 0
          : assertInteger(source.tries, 'effect.tries', { min: 0 }),
      result: source.result,
      appliedAt:
        source.appliedAt === undefined
          ? status === 'applied'
            ? timestamp
            : undefined
          : assertNumber(source.appliedAt, 'effect.appliedAt'),
      updatedAt: timestamp,
    });
    validateEffectRecord(record);
    validateValueSizes(EFFECT_ENTITY, record);

    const created = await backend.putIfAbsent(
      EFFECT_ENTITY,
      requestKey,
      record,
    );
    if (created) {
      return {
        effect: /** @type {import('./types.js').Effect} */ ({
          requestKey,
          ...record,
        }),
        created: true,
      };
    }

    const existing = await getEffect(requestKey);
    if (!existing) {
      throw new NotFoundError(EFFECT_ENTITY, requestKey);
    }
    return { effect: existing, created: false };
  }

  /**
   * @param {string} requestKey
   * @returns {Promise<import('./types.js').Effect|null>}
   */
  async function getEffect(requestKey) {
    assertString(requestKey, 'requestKey');
    const row = await backend.get(EFFECT_ENTITY, requestKey);
    return row
      ? /** @type {import('./types.js').Effect} */ (withId('requestKey', row))
      : null;
  }

  /**
   * @param {string} requestKey
   * @param {Partial<import('./types.js').Effect>} patch
   * @returns {Promise<import('./types.js').Effect>}
   */
  async function updateEffect(requestKey, patch, updateOptions) {
    assertString(requestKey, 'requestKey');
    const expectedStatus =
      updateOptions === undefined || updateOptions === null
        ? undefined
        : updateOptions.expectedStatus === undefined
          ? undefined
          : assertEnum(
              updateOptions.expectedStatus,
              'effect.expectedStatus',
              EFFECT_STATUSES,
            );
    const existing = await getEffect(requestKey);
    if (!existing) {
      throw new NotFoundError(EFFECT_ENTITY, requestKey);
    }
    if (
      expectedStatus !== undefined &&
      existing.status !== expectedStatus
    ) {
      throw new ConflictError(
        EFFECT_ENTITY,
        requestKey,
        existing.updatedAt,
        existing.updatedAt,
      );
    }
    if (
      patch &&
      typeof patch === 'object' &&
      patch.requestKey !== undefined &&
      patch.requestKey !== requestKey
    ) {
      throw new StoreValidationError(
        'effect.requestKey is immutable and cannot be patched',
      );
    }

    const merged = applyPatch(
      /** @type {Record<string, unknown>} */ (existing),
      patch,
      ['requestKey'],
      EFFECT_ENTITY,
    );
    merged.updatedAt = nextTimestamp(existing.updatedAt, clock);
    if (merged.status === 'applied' && patch.appliedAt === undefined) {
      merged.appliedAt ??= merged.updatedAt;
    }
    validateEffectRecord(merged);
    validateValueSizes(EFFECT_ENTITY, merged);

    // No expected status: last write wins, which is what older callers use.
    // With expectedStatus, the backend compares the stored status and refuses
    // the write when another invocation already changed it.
    if (expectedStatus === undefined) {
      await backend.set(EFFECT_ENTITY, requestKey, merged);
      return /** @type {import('./types.js').Effect} */ (merged);
    }

    const updated = await backend.updateIfMatch(
      EFFECT_ENTITY,
      requestKey,
      merged,
      'status',
      expectedStatus,
    );
    if (!updated) {
      const current = await getEffect(requestKey);
      throw new ConflictError(
        EFFECT_ENTITY,
        requestKey,
        existing.updatedAt,
        current?.updatedAt ?? null,
      );
    }
    return /** @type {import('./types.js').Effect} */ (merged);
  }

  /**
   * @param {string} runId
   * @param {import('./types.js').ListOptions} [listOptions]
   * @returns {Promise<import('./types.js').Effect[]>}
   */
  async function listEffectsByRun(runId, listOptions) {
    assertString(runId, 'runId');
    const limit = readLimit(listOptions, 'listEffectsByRun');
    if (limit === 0) {
      return [];
    }
    const rows = await backend.query(EFFECT_ENTITY, 'by-run', {
      partition: [runId],
      range: { op: 'gte', value: 0 },
      direction: 'DESC',
      limit,
    });
    return rows.map((row) => /** @type {import('./types.js').Effect} */ (withId('requestKey', row)));
  }

  /**
   * @param {string} issueKey
   * @returns {Promise<import('./types.js').Step|null>}
   */
  async function getStepByChildIssueKey(issueKey) {
    assertString(issueKey, 'issueKey');
    const rows = await backend.query(STEP_ENTITY, 'by-child-issue', {
      partition: [issueKey],
      range: { op: 'gte', value: 0 },
      direction: 'DESC',
      limit: 1,
    });
    const row = rows[0];
    return row
      ? /** @type {import('./types.js').Step} */ (withId('stepId', row))
      : null;
  }

  /**
   * @param {import('./types.js').EffectStatus} status
   * @param {import('./types.js').ListOptions} [listOptions]
   * @returns {Promise<import('./types.js').Effect[]>}
   */
  async function listEffectsByStatus(status, listOptions) {
    assertEnum(status, 'effect.status', EFFECT_STATUSES);
    const limit = readLimit(listOptions, 'listEffectsByStatus');
    if (limit === 0) {
      return [];
    }
    const rows = await backend.query(EFFECT_ENTITY, 'by-status', {
      partition: [status],
      range: { op: 'gte', value: 0 },
      direction: 'ASC',
      limit,
    });
    return rows.map((row) => /** @type {import('./types.js').Effect} */ (withId('requestKey', row)));
  }

  /**
   * @param {import('./types.js').MemoryInput} memory
   * @returns {Promise<import('./types.js').Memory>}
   */
  async function addMemory(memory) {
    memoryListCache.clear();
    const source = assertPlainObject(memory, 'addMemory memory');
    if (
      source.memType !== undefined &&
      source.type !== undefined &&
      source.memType !== source.type
    ) {
      throw new StoreValidationError(
        'memory.memType and memory.type disagree; use memType',
      );
    }
    const memType = source.memType ?? source.type;
    const timestamp = clock();
    const record = cleanRecord({
      projectKey: assertString(source.projectKey, 'memory.projectKey'),
      scope:
        source.scope === undefined
          ? 'project'
          : assertEnum(source.scope, 'memory.scope', MEMORY_SCOPES),
      memType: assertEnum(memType, 'memory.memType', MEMORY_TYPES),
      text: assertString(source.text, 'memory.text'),
      sourceIssue: assertString(source.sourceIssue, 'memory.sourceIssue', {
        optional: true,
      }),
      runId: assertString(source.runId, 'memory.runId', { optional: true }),
      validUntil:
        source.validUntil === undefined
          ? 0
          : assertNumber(source.validUntil, 'memory.validUntil'),
      supersededBy: assertString(
        source.supersededBy,
        'memory.supersededBy',
        { optional: true },
      ),
      createdAt:
        source.createdAt === undefined
          ? timestamp
          : assertNumber(source.createdAt, 'memory.createdAt'),
    });
    validateMemoryRecord(record);
    validateValueSizes(MEMORY_ENTITY, record);

    const memId =
      source.memId === undefined
        ? newId()
        : assertString(source.memId, 'memory.memId');
    await backend.set(MEMORY_ENTITY, memId, record);
    return /** @type {import('./types.js').Memory} */ ({ memId, ...record });
  }

  /**
   * @param {string} projectKey
   * @param {import('./types.js').ListOptions} [listOptions]
   * @returns {Promise<import('./types.js').Memory[]>}
   */
  async function listMemoriesByProject(projectKey, listOptions) {
    assertString(projectKey, 'projectKey');
    const fresh = listOptions?.fresh === true;
    const limitOptions = listOptions && 'fresh' in listOptions
      ? { ...listOptions, fresh: undefined }
      : listOptions;
    // Cap: newest MEMORY_LIST_CAP rows, so the read does not grow with
    // every run. Callers can still pass an explicit limit.
    const limit = readLimit(limitOptions, 'listMemoriesByProject') ?? MEMORY_LIST_CAP;
    if (limit === 0) {
      return [];
    }
    const cacheKey = `${projectKey}|${limit}`;
    const cached = memoryListCache.get(cacheKey);
    if (!fresh && cached && clock() - cached.at < MEMORY_CACHE_MS) {
      return cached.rows.slice();
    }
    const rows = await backend.query(MEMORY_ENTITY, 'by-project', {
      partition: [projectKey],
      range: { op: 'gte', value: 0 },
      direction: 'DESC',
      limit,
    });
    const memories = rows.map((row) => /** @type {import('./types.js').Memory} */ (withId('memId', row)));
    memoryListCache.set(cacheKey, { at: clock(), rows: memories });
    return memories.slice();
  }

  /**
   * @param {string} memId
   * @param {string} byMemId
   * @returns {Promise<import('./types.js').Memory>}
   */
  async function supersedeMemory(memId, byMemId) {
    memoryListCache.clear();
    assertString(memId, 'memId');
    assertString(byMemId, 'byMemId');
    const row = await backend.get(MEMORY_ENTITY, memId);
    if (!row) {
      throw new NotFoundError(MEMORY_ENTITY, memId);
    }
    const merged = cleanRecord({ ...row.record, supersededBy: byMemId });
    validateMemoryRecord(merged);
    validateValueSizes(MEMORY_ENTITY, merged);
    await backend.set(MEMORY_ENTITY, memId, merged);
    return /** @type {import('./types.js').Memory} */ ({
      memId,
      ...merged,
    });
  }

  /**
   * Validate one flight-recorder row before it is written. `eventId` is the
   * key and must not be part of the record; callers never pass it.
   *
   * @param {Record<string, unknown>} record
   * @returns {void}
   */
  function validateEventRecord(record) {
    assertString(record.runId, 'event.runId');
    assertInteger(record.seq, 'event.seq', { min: 0 });
    assertEnum(record.kind, 'event.kind', EVENT_KINDS);
    assertNumber(record.at, 'event.at');
    assertString(record.stepId, 'event.stepId', { optional: true });
    assertInteger(record.stepIdx, 'event.stepIdx', { optional: true, min: 0 });
    assertString(record.journalKey, 'event.journalKey', { optional: true });
    if (record.span !== undefined) {
      assertPlainObject(record.span, 'event.span');
    }
    if (Object.prototype.hasOwnProperty.call(record, 'eventId')) {
      throw new StoreValidationError(
        'event.eventId is the entity key and must not be stored as an attribute',
      );
    }
  }

  /**
   * Next integer seq for a run. The range query is on `seq` (integer), never
   * on the float timestamp `at`. A lost race retries with putIfAbsent.
   *
   * @param {string} runId
   * @returns {Promise<number>}
   */
  async function nextEventSeq(runId) {
    // After this instance wrote an event, the next seq is known without a
    // read. putIfAbsent still guards the key, so a stale guess only costs a
    // retry with attempt + 1, never a duplicate row.
    if (eventSeqCache.has(runId)) {
      return eventSeqCache.get(runId) + 1;
    }
    const newest = await backend.query(EVENT_ENTITY, 'by-run', {
      partition: [runId],
      range: { op: 'gte', value: 0 },
      direction: 'DESC',
      limit: 1,
    });
    if (newest.length === 0) {
      return 0;
    }
    return Number(newest[0].record.seq) + 1;
  }

  /**
   * Append one flight-recorder event. The row is never updated afterwards.
   *
   * The entity key is `${runId}#${seq}`. That string is not an attribute.
   * `runId` is stored as an attribute because the by-run index partitions on
   * it; it is not the key. Writing the key field name (`eventId`) would be an
   * undeclared attribute and Forge would reject the write with a bare 422.
   *
   * @param {import('./types.js').EventInput} input
   * @returns {Promise<import('./types.js').FlightEvent>}
   */
  async function appendEvent(input) {
    const source = assertPlainObject(input, 'appendEvent input');
    const runId = assertString(source.runId, 'event.runId');
    const kind = assertEnum(source.kind, 'event.kind', EVENT_KINDS);
    const at =
      source.at === undefined
        ? clock()
        : assertNumber(source.at, 'event.at');

    let bump = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      // A cached guess that loses only drops the cache; the bump is for
      // repeated losses after a fresh read, as before.
      const cachedHit = eventSeqCache.has(runId);
      const seq = (await nextEventSeq(runId)) + (cachedHit ? 0 : bump);
      const record = cleanRecord({
        runId,
        seq,
        kind,
        at,
        stepId: assertString(source.stepId, 'event.stepId', { optional: true }),
        stepIdx: assertInteger(source.stepIdx, 'event.stepIdx', {
          optional: true,
          min: 0,
        }),
        journalKey: assertString(source.journalKey, 'event.journalKey', {
          optional: true,
        }),
        span: source.span,
        detail: trimEventDetail(source.detail),
      });
      validateEventRecord(record);
      validateValueSizes(EVENT_ENTITY, record);
      // Pad seq so the key sorts the same way the integer index does. The
      // key regex allows `#`. putIfAbsent makes a duplicate seq a retry,
      // not a second row.
      const eventId = `${runId}#${String(seq).padStart(8, '0')}`;
      const wrote = await backend.putIfAbsent(EVENT_ENTITY, eventId, record);
      if (!wrote) {
        // Another writer took this seq: drop the guess, re-read next time.
        eventSeqCache.delete(runId);
        if (!cachedHit) {
          bump += 1;
        }
      }
      if (wrote) {
        eventSeqCache.set(runId, seq);
        return /** @type {import('./types.js').FlightEvent} */ ({
          eventId,
          ...record,
        });
      }
    }
    throw new StoreError(
      `Could not append an event for run ${runId}`,
      'EVENT_APPEND_CONFLICT',
    );
  }

  /**
   * Events for one run, oldest seq first. The panel scrubs this list.
   *
   * @param {string} runId
   * @param {import('./types.js').ListOptions} [listOptions]
   * @returns {Promise<import('./types.js').FlightEvent[]>}
   */
  async function listEventsByRun(runId, listOptions) {
    assertString(runId, 'runId');
    const limit = readLimit(listOptions, 'listEventsByRun');
    if (limit === 0) {
      return [];
    }
    const rows = await backend.query(EVENT_ENTITY, 'by-run', {
      partition: [runId],
      range: { op: 'gte', value: 0 },
      direction: 'ASC',
      limit,
    });
    return rows.map(
      (row) => /** @type {import('./types.js').FlightEvent} */ (
        withId('eventId', row)
      ),
    );
  }

  /**
   * Journal lookup by requestKey (or step-result key). Replay and fork use
   * this instead of writing the same Jira effect again. The range is `seq`
   * (integer), not the float `at`.
   *
   * @param {string} journalKey
   * @param {import('./types.js').ListOptions} [listOptions]
   * @returns {Promise<import('./types.js').FlightEvent[]>}
   */
  async function listEventsByJournalKey(journalKey, listOptions) {
    assertString(journalKey, 'journalKey');
    const limit = readLimit(listOptions, 'listEventsByJournalKey');
    if (limit === 0) {
      return [];
    }
    const rows = await backend.query(EVENT_ENTITY, 'by-journal', {
      partition: [journalKey],
      range: { op: 'gte', value: 0 },
      direction: 'ASC',
      limit,
    });
    return rows.map(
      (row) => /** @type {import('./types.js').FlightEvent} */ (
        withId('eventId', row)
      ),
    );
  }

  return {
    createRun,
    getRun,
    listRunsByEpic,
    updateRun,
    createSteps,
    getStep,
    listSteps,
    updateStep,
    findStuckSteps,
    putEffectIfAbsent,
    getEffect,
    updateEffect,
    listEffectsByStatus,
    listEffectsByRun,
    getStepByChildIssueKey,
    addMemory,
    listMemoriesByProject,
    supersedeMemory,
    appendEvent,
    listEventsByRun,
    listEventsByJournalKey,
  };
}
