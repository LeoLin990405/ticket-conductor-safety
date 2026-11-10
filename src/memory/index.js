/**
 * WP6 run memory: write-back, recall, and explicit record (docs/TASKS.md).
 *
 * The three public entry points are:
 *
 * ```js
 * writeBack(runId, {summary, decisions: [{text, type}]}) -> {memIds}
 * recall({projectKey, query, k = 5}) -> Memory[]
 * record({projectKey, epicKey, text, type}) -> {memId}
 * ```
 *
 * Dependencies are injected so unit tests run without WP2 on the branch:
 *
 * ```js
 * import { createMemory } from '../memory/index.js';
 * const memory = createMemory({store, enqueueEffect});
 * ```
 *
 * The named exports use the WP1 store singleton (`getStore()` / `setStore()`)
 * and lazily load the WP2 effects module (`src/effects/index.js`) on the first
 * `writeBack`. Tests and callers can replace that dependency with
 * `setMemoryEffects(...)`, `createMemoryService({enqueueEffect})`, or the
 * optional third argument on each named export.
 *
 * Storage rules implemented here (docs/SPIKES.md, "Impact on WP1–WP9"):
 * - `recall` reads the `by-project` index and scores in memory.
 * - It skips rows with `supersededBy` set and rows whose `validUntil` is a past
 *   timestamp; `validUntil: 0` means no expiry.
 * - The WP1 entity attribute is `memType`; WP6's input field is `type`.
 * - The Epic comment is one deduped WP2 `comment` effect per run.
 *
 * @module memory
 */

import { recordEvent } from '../recorder/log.js';
import {
  getStore,
  NotFoundError,
  StoreValidationError,
} from '../store/index.js';
import {
  MEMORY_COMMENT_DISCRIMINATOR,
  MEMORY_COMMENT_HEADER,
  buildMemoryComment,
} from './comment.js';
import { scoreMemory } from './scoring.js';
import {
  GLOBAL_PROJECT_KEY,
  RECALL_BUDGET_BYTES,
  activeAt,
  defaultConfidence,
  isHiddenFromRecall,
  lessonSummary,
  parseLesson,
  temporalBounds,
  truncateUtf8,
  utf8Size,
} from './lessonText.js';
import {
  acceptLesson,
  addLesson,
  applyMemoriesToPlan,
  describeRunMemory,
  downvoteLesson,
  editLesson,
  lessonOp,
  lessonsAt,
  listLessons,
  publishPlanCard,
  recordFailureLesson,
  recordPlanCitations,
  rejectLesson,
  upvoteLesson,
} from './lessons.js';

export {
  GLOBAL_PROJECT_KEY,
  RECALL_BUDGET_BYTES,
} from './lessonText.js';
export {
  acceptLesson,
  addLesson,
  applyMemoriesToPlan,
  describeRunMemory,
  downvoteLesson,
  editLesson,
  lessonOp,
  lessonsAt,
  listLessons,
  publishPlanCard,
  recordFailureLesson,
  recordPlanCitations,
  rejectLesson,
  upvoteLesson,
};

export { MEMORY_COMMENT_DISCRIMINATOR, MEMORY_COMMENT_HEADER };

/** Memory categories accepted by WP1. @constant {ReadonlyArray<string>} */
const MEMORY_TYPES = Object.freeze(['decision', 'lesson', 'fact']);

/** Memory scopes accepted by WP1. @constant {ReadonlyArray<string>} */
const MEMORY_SCOPES = Object.freeze(['project', 'epic']);

/** Default number of memories returned by `recall`. @constant {number} */
const DEFAULT_RECALL_K = 5;

/**
 * One decision supplied to `writeBack`. WP6 input uses `type`; WP1 stores it
 * as `memType`.
 *
 * @typedef {object} WriteBackDecision
 * @property {string} text Decision, lesson, or fact to remember.
 * @property {'decision'|'lesson'|'fact'} [type] Defaults to `decision`.
 */

/**
 * @typedef {object} WriteBackInput
 * @property {string|object} [summary] Run summary for the Epic comment. It is
 *   not stored as a separate memory row; WP3 keeps `run.summary`.
 * @property {WriteBackDecision[]} [decisions] Memories to store for the project.
 */

/**
 * @typedef {object} WriteBackResult
 * @property {string[]} memIds IDs of the memories created or reused for this run.
 */

/**
 * @typedef {object} RecallInput
 * @property {string} projectKey Jira project key.
 * @property {string|string[]|object} query Goal text, or an object whose string
 *   values (for example `{goal, labels}`) are searched together.
 * @property {number} [k] Maximum results, default 5.
 * @property {string} [epicKey] Same-Epic memories are ranked above an equal match.
 * @property {number} [asOf] Replay timestamp. When set, a superseded lesson is
 *   returned if it was the version that held at that time.
 * @property {number} [budgetBytes] UTF-8 cap on the returned text. Default
 *   1536. The cap is applied in process, not as a storage query.
 * @property {boolean} [acceptedLessonsOnly] When true, planner-rule lessons
 *   are returned only if they are accepted, have at least one vote, and
 *   carry a scope. Their text is the prose summary, not the envelope.
 */

/**
 * @typedef {object} RecordInput
 * @property {string} projectKey Jira project key.
 * @property {string} epicKey Epic the decision came from.
 * @property {string} text Text to remember.
 * @property {'decision'|'lesson'|'fact'} [type] Defaults to `decision`.
 * @property {'project'|'epic'} [scope] Defaults to `project`.
 * @property {number} [validUntil] Epoch ms, or 0 for no expiry (default).
 * @property {string} [runId] Optional run that produced the memory.
 */

/**
 * @typedef {object} RecordResult
 * @property {string} memId New memory ID.
 */

/**
 * Dependencies accepted by `createMemoryService` and by the optional final
 * argument of `writeBack`, `recall`, and `record`.
 *
 * @typedef {object} MemoryDependencies
 * @property {import('../store/types.js').Store|(() => import('../store/types.js').Store)} [store]
 * @property {{enqueueEffect: Function}|Function} [effects] WP2 effects module or object.
 * @property {Function} [enqueueEffect] Convenience form of `effects.enqueueEffect`.
 * @property {() => number} [now] Clock returning epoch ms, injectable for tests.
 */

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
function assertPlainObject(value, label) {
  if (value === undefined || value === null || typeof value !== 'object') {
    throw new StoreValidationError(`${label} must be an object`);
  }
  if (Array.isArray(value)) {
    throw new StoreValidationError(`${label} must be an object, not an array`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function assertNonEmptyString(value, label) {
  if (typeof value !== 'string') {
    throw new StoreValidationError(`${label} must be a string`);
  }
  if (value.trim().length === 0) {
    throw new StoreValidationError(`${label} must not be empty`);
  }
  return value;
}

/**
 * Accept a plain-text summary, or stringify an already-structured summary.
 * `run.summary` is `any` in WP1 and a summarize worker may hand WP6 an object.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeSummary(value) {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'object') {
    let json;
    try {
      json = JSON.stringify(value);
    } catch (error) {
      throw new StoreValidationError(
        `writeBack summary is not JSON-serializable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (json === undefined) {
      throw new StoreValidationError(
        'writeBack summary is not JSON-serializable',
      );
    }
    return json;
  }
  return String(value);
}

/**
 * Resolve and validate the `type`/`memType` pair from an input object.
 * Accepting `memType` as an alias keeps action callers that already use the
 * storage name working, while rejecting a contradictory pair.
 *
 * @param {Record<string, unknown>} source
 * @param {string} label
 * @returns {'decision'|'lesson'|'fact'}
 */
function resolveMemoryType(source, label) {
  if (
    source.type !== undefined &&
    source.memType !== undefined &&
    source.type !== source.memType
  ) {
    throw new StoreValidationError(
      `${label}: type and memType disagree; use type`,
    );
  }
  const value = source.memType ?? source.type;
  if (value === undefined || value === null) {
    return 'decision';
  }
  const type = assertNonEmptyString(value, label);
  if (!MEMORY_TYPES.includes(type)) {
    throw new StoreValidationError(
      `${label} must be one of ${MEMORY_TYPES.join(', ')}; received ${type}`,
    );
  }
  return /** @type {'decision'|'lesson'|'fact'} */ (type);
}

/**
 * @param {unknown} value
 * @returns {'project'|'epic'}
 */
function normalizeScope(value) {
  if (value === undefined || value === null) {
    return 'project';
  }
  const scope = assertNonEmptyString(value, 'record scope');
  if (!MEMORY_SCOPES.includes(scope)) {
    throw new StoreValidationError(
      `record scope must be one of ${MEMORY_SCOPES.join(', ')}; received ${scope}`,
    );
  }
  return /** @type {'project'|'epic'} */ (scope);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeValidUntil(value) {
  if (value === undefined || value === null) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new StoreValidationError(
      'record validUntil must be a finite epoch-millisecond number',
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {WriteBackDecision[]}
 */
function normalizeDecisions(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new StoreValidationError('writeBack decisions must be an array');
  }
  return value.map((decision, index) => {
    const source = assertPlainObject(
      decision,
      `writeBack decisions[${index}]`,
    );
    const text = assertNonEmptyString(
      source.text,
      `writeBack decisions[${index}].text`,
    ).trim();
    return {
      text,
      type: resolveMemoryType(
        source,
        `writeBack decisions[${index}].type`,
      ),
    };
  });
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeK(value) {
  if (value === undefined || value === null) {
    return DEFAULT_RECALL_K;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new StoreValidationError(
      'recall k must be a non-negative integer',
    );
  }
  return value;
}

/**
 * Injection budget. The default is {@link RECALL_BUDGET_BYTES}. Zero returns
 * nothing. This is not a KVS filter.
 *
 * @param {unknown} value
 * @returns {number}
 */
function normalizeBudget(value) {
  if (value === undefined || value === null) {
    return RECALL_BUDGET_BYTES;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new StoreValidationError(
      'recall budgetBytes must be a non-negative integer',
    );
  }
  return value;
}

/**
 * Attach the confidence, tier, and validity window callers read. The stored
 * row is not modified. Confidence for a plain decision is a default; a lesson
 * envelope carries its own score.
 *
 * @param {import('../store/types.js').Memory} memory
 * @param {Map<string, object>} byId
 * @returns {import('../store/types.js').Memory}
 */
function decorateMemory(memory, byId) {
  const bounds = temporalBounds(memory, byId);
  const lesson = parseLesson(memory);
  const lessonConfidence = typeof lesson?.confidence === 'number'
    ? lesson.confidence
    : typeof memory.confidence === 'number'
      ? memory.confidence
      : parseLessonConfidence(memory);
  return {
    ...memory,
    confidence: lessonConfidence ?? defaultConfidence(memory.memType),
    // A global lesson is stored with the entity scope `project` and the
    // pool key `__global__`. Callers should see the envelope scope.
    scope: lesson?.scope || memory.scope,
    tier: lesson?.tier || (memory.projectKey === GLOBAL_PROJECT_KEY ? 'global' : 'project'),
    validFrom: bounds.validFrom,
    validTo: bounds.validTo,
  };
}

/**
 * @param {object} memory
 * @returns {number|null}
 */
function parseLessonConfidence(memory) {
  const marker = '[Conductor lesson]';
  const text = typeof memory.text === 'string' ? memory.text : '';
  const at = text.indexOf(marker);
  if (at === -1) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(at + marker.length).trim());
    return typeof parsed?.confidence === 'number' ? parsed.confidence : null;
  } catch {
    return null;
  }
}

/**
 * Flatten a query into one search string. A string is used as-is; arrays and
 * objects contribute every string/number/boolean leaf, so `{goal, labels}`
 * works without a second contract.
 *
 * @param {unknown} value
 * @param {string[]} out
 * @returns {void}
 */
function collectQueryText(value, out) {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value === 'string') {
    if (value.trim().length > 0) {
      out.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectQueryText(item, out);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectQueryText(item, out);
    }
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeQuery(value) {
  /** @type {string[]} */
  const parts = [];
  collectQueryText(value, parts);
  return parts.join(' ').trim();
}

/**
 * Identity of a memory inside one run, used to make write-back retries
 * idempotent. Two decisions with the same category and text are one memory.
 *
 * @param {string} type
 * @param {string} text
 * @returns {string}
 */
function memoryIdentity(type, text) {
  return `${type}\u0000${text}`;
}

/** Store methods WP6 calls. @constant {ReadonlyArray<string>} */
const REQUIRED_STORE_METHODS = Object.freeze([
  'getRun',
  'listMemoriesByProject',
  'addMemory',
]);

/**
 * @param {unknown} store
 * @returns {import('../store/types.js').Store}
 */
function assertStore(store) {
  if (store === undefined || store === null || typeof store !== 'object') {
    throw new TypeError('memory: store must be a WP1 store object');
  }
  for (const method of REQUIRED_STORE_METHODS) {
    if (typeof store[method] !== 'function') {
      throw new TypeError(`memory: store.${method} must be a function`);
    }
  }
  return /** @type {import('../store/types.js').Store} */ (store);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {{enqueueEffect: Function}}
 */
function normalizeEffects(value, label) {
  if (
    value !== undefined &&
    value !== null &&
    typeof value === 'object' &&
    typeof value.enqueueEffect === 'function'
  ) {
    return /** @type {{enqueueEffect: Function}} */ (value);
  }
  if (typeof value === 'function') {
    return { enqueueEffect: value };
  }
  throw new TypeError(
    `${label}: expected a WP2 effects object exposing enqueueEffect() or an enqueueEffect function`,
  );
}

/** Module-level WP2 replacement installed by `setMemoryEffects`. */
let moduleEffects = null;

/**
 * Install the WP2 effects dependency for the named exports.
 *
 * @param {{enqueueEffect: Function}|Function|null} effects
 * @returns {{enqueueEffect: Function}|null}
 */
export function setMemoryEffects(effects) {
  if (effects === undefined || effects === null) {
    moduleEffects = null;
    return null;
  }
  moduleEffects = normalizeEffects(effects, 'setMemoryEffects');
  return moduleEffects;
}

/**
 * Drop the module-level WP2 replacement so the lazy import is used again.
 * Mainly useful between tests.
 *
 * @returns {void}
 */
export function resetMemoryEffects() {
  moduleEffects = null;
}

/**
 * Load `src/effects/index.js` on first use. The module does not exist on the
 * WP6-only branch, so it is never imported at module load time and tests
 * always inject a stub.
 *
 * @returns {Promise<{enqueueEffect: Function}>}
 */
async function loadDefaultEffects() {
  if (moduleEffects) {
    return moduleEffects;
  }
  let loaded;
  try {
    loaded = await import('../effects/index.js');
  } catch (error) {
    const wrapped = new Error(
      'WP6 writeBack needs the WP2 effects queue. Pass {enqueueEffect} to writeBack, ' +
        'use createMemoryService({enqueueEffect}), call setMemoryEffects(...), ' +
        'or merge WP2 so src/effects/index.js exists.',
      { cause: error },
    );
    wrapped.code = 'MEMORY_EFFECTS_UNAVAILABLE';
    throw wrapped;
  }
  return normalizeEffects(loaded, 'WP2 effects module');
}

/**
 * Create a memory service with explicit dependencies. Production callers can
 * use the named exports instead; tests and scenario harnesses use this form.
 *
 * @param {MemoryDependencies} [options]
 * @returns {{
 *   writeBack: (runId: string, input: WriteBackInput) => Promise<WriteBackResult>,
 *   recall: (input: RecallInput) => Promise<import('../store/types.js').Memory[]>,
 *   record: (input: RecordInput) => Promise<RecordResult>
 * }}
 */
export function createMemoryService(options = {}) {
  const source = assertPlainObject(options, 'createMemoryService options');
  const storeOption = source.store;
  const now = source.now ?? (() => Date.now());
  if (typeof now !== 'function') {
    throw new TypeError('createMemoryService now must be a function');
  }

  let injectedEffects = null;
  if (source.enqueueEffect !== undefined) {
    injectedEffects = normalizeEffects(
      { enqueueEffect: source.enqueueEffect },
      'createMemoryService enqueueEffect',
    );
  } else if (source.effects !== undefined && source.effects !== null) {
    injectedEffects = normalizeEffects(
      source.effects,
      'createMemoryService effects',
    );
  }

  /** @returns {import('../store/types.js').Store} */
  function activeStore() {
    const candidate =
      typeof storeOption === 'function' ? storeOption() : storeOption;
    return assertStore(candidate ?? getStore());
  }

  /** @returns {Promise<{enqueueEffect: Function}>} */
  async function activeEffects() {
    return injectedEffects ?? loadDefaultEffects();
  }

  /**
   * Store memory rows for the decisions and enqueue exactly one Epic comment
   * effect. Repeating the call for the same run reuses rows with the same
   * `(memType, text)` and reuses the same WP2 request key, so an at-least-once
   * summarize worker does not duplicate memory.
   *
   * @param {string} runId
   * @param {WriteBackInput} input
   * @returns {Promise<WriteBackResult>}
   */
  async function writeBack(runId, input) {
    const runKey = assertNonEmptyString(runId, 'writeBack runId');
    const payload = assertPlainObject(input, 'writeBack input');
    const summary = normalizeSummary(payload.summary);
    const decisions = normalizeDecisions(payload.decisions);

    if (summary.length === 0 && decisions.length === 0) {
      throw new StoreValidationError(
        'writeBack requires a non-empty summary or at least one decision',
      );
    }

    const store = activeStore();
    const run = await store.getRun(runKey);
    if (!run) {
      throw new NotFoundError('run', runKey);
    }

    // Memory rows are idempotent per run. The by-project index already returns
    // this run's rows, so one read covers a retry after a partial write.
    const existingMemories = await store.listMemoriesByProject(
      run.projectKey,
      { fresh: true },
    );
    /** @type {Map<string, import('../store/types.js').Memory>} */
    const existingByKey = new Map();
    for (const memory of existingMemories) {
      if (memory.runId !== runKey) {
        continue;
      }
      const key = memoryIdentity(
        memory.memType ?? memory.type ?? 'decision',
        memory.text,
      );
      if (!existingByKey.has(key)) {
        existingByKey.set(key, memory);
      }
    }

    /** @type {string[]} */
    const memIds = [];
    const seenInInput = new Set();
    for (const decision of decisions) {
      const key = memoryIdentity(decision.type, decision.text);
      if (seenInInput.has(key)) {
        continue;
      }
      seenInInput.add(key);

      const existing = existingByKey.get(key);
      if (existing) {
        memIds.push(existing.memId);
        continue;
      }

      // Summarize (and any other write-back) puts model lessons on
      // `decisions` with type `lesson`. Those become proposed planner
      // lessons. addLesson dedupes an identical one, so a second summarize
      // does not store a second row, and we do not also keep a plain copy.
      if (decision.type === 'lesson') {
        const recorded = await addLesson({
          projectKey: run.projectKey,
          scope: 'project',
          epicKey: run.epicKey,
          runId: runKey,
          text: decision.text,
          cause: decision.text,
          goal: typeof run.goal === 'string' ? run.goal : '',
          kind: 'summarize',
          workerType: 'summarize',
          status: 'proposed',
          votes: 0,
          confidence: 0.55,
        }, { store, now });
        memIds.push(recorded.lessonId);
        continue;
      }

      const memory = await store.addMemory({
        projectKey: run.projectKey,
        scope: 'project',
        memType: decision.type,
        text: decision.text,
        sourceIssue: run.epicKey,
        runId: runKey,
        validUntil: 0,
      });
      existingByKey.set(key, memory);
      memIds.push(memory.memId);
      await recordEvent(store, {
        runId: runKey,
        kind: 'memory.written',
        journalKey: memory.memId,
        detail: {
          memId: memory.memId,
          memType: memory.memType,
          text: String(memory.text ?? '').slice(0, 180),
        },
      });
    }

    const comment = buildMemoryComment({ summary, decisions });
    const effects = await activeEffects();
    await effects.enqueueEffect({
      runId: runKey,
      // writeBack has no step of its own. `null` is explicit and stable for
      // WP2's sha256(runId|stepId|kind|discriminator) request key.
      stepId: null,
      kind: 'comment',
      payload: {
        issueKey: run.epicKey,
        bodyText: comment.bodyText,
        bodyAdf: comment.bodyAdf,
      },
      discriminator: MEMORY_COMMENT_DISCRIMINATOR,
    });

    return { memIds };
  }

  /**
   * Recall the top-k memories for a project whose text, source issue, labels,
   * or category overlaps the query. Superseded and expired rows are excluded
   * before scoring.
   *
   * @param {RecallInput} input
   * @returns {Promise<import('../store/types.js').Memory[]>}
   */
  async function recall(input) {
    const source = assertPlainObject(input, 'recall input');
    const projectKey = assertNonEmptyString(
      source.projectKey,
      'recall projectKey',
    );
    const k = normalizeK(source.k);
    const query = normalizeQuery(source.query);
    const epicKey = typeof source.epicKey === 'string' ? source.epicKey.trim() : '';
    const budgetBytes = normalizeBudget(source.budgetBytes);
    const asOf = source.asOf;
    if (asOf !== undefined && (typeof asOf !== 'number' || !Number.isFinite(asOf))) {
      throw new StoreValidationError(
        'recall asOf must be an epoch-millisecond number',
      );
    }

    // No query terms means no keyword overlap. Returning recent memories
    // would make recall look like an unscoped list, which is not the contract.
    if (k === 0 || query.length === 0 || budgetBytes === 0) {
      return [];
    }

    const store = activeStore();
    // Two tiers: this Jira project, plus the global pool. Both reads use the
    // by-project index. Expiry and confidence stay in process because
    // `validUntil` is a float and this code does not put a condition on it.
    const projectMemories = await store.listMemoriesByProject(projectKey);
    const globalMemories = projectKey === GLOBAL_PROJECT_KEY
      ? []
      : await store.listMemoriesByProject(GLOBAL_PROJECT_KEY);
    const memories = projectMemories.concat(globalMemories);
    const byId = new Map(memories.map((memory) => [memory.memId, memory]));
    const nowMs = now();

    /** @type {Array<{memory: import('../store/types.js').Memory, score: number}>} */
    const ranked = [];
    for (const memory of memories) {
      if (isHiddenFromRecall(memory)) {
        continue;
      }
      if (!memory.scope) {
        // Fail closed: a row with no scope is not readable.
        continue;
      }
      if (asOf !== undefined) {
        if (!activeAt(memory, byId, asOf)) {
          continue;
        }
      } else if (memory.supersededBy) {
        continue;
      } else {
        const validUntil =
          typeof memory.validUntil === 'number' ? memory.validUntil : 0;
        if (validUntil !== 0 && validUntil <= nowMs) {
          continue;
        }
      }

      const lesson = parseLesson(memory);
      /** @type {typeof memory} */
      let viewed = memory;
      if (lesson) {
        if (!lesson.scope) {
          continue;
        }
        if (source.acceptedLessonsOnly === true) {
          if (lesson.status !== 'accepted' || !(lesson.votes >= 1)) {
            continue;
          }
          // The tool contract shows the lesson a person can read. The
          // envelope stays in storage. Budget is counted on this prose.
          viewed = {
            ...memory,
            text: lessonSummary(memory),
            scope: lesson.scope,
            confidence: lesson.confidence,
            tier: lesson.tier,
          };
        }
      }

      let score = scoreMemory(viewed, query);
      if (score <= 0) {
        continue;
      }
      if (epicKey && memory.sourceIssue === epicKey) {
        score += 1.5;
      }
      // A global lesson can answer, but a project lesson with the same
      // overlap is the closer match.
      if (memory.projectKey === GLOBAL_PROJECT_KEY) {
        score *= 0.9;
      }
      ranked.push({ memory: viewed, score });
    }

    ranked.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      const createdDelta =
        (right.memory.createdAt ?? 0) - (left.memory.createdAt ?? 0);
      if (createdDelta !== 0) {
        return createdDelta;
      }
      return String(left.memory.memId).localeCompare(
        String(right.memory.memId),
      );
    });

    /** @type {import('../store/types.js').Memory[]} */
    const chosen = [];
    let usedBytes = 0;
    for (const entry of ranked) {
      if (chosen.length >= k) {
        break;
      }
      const size = utf8Size(entry.memory.text);
      if (size > budgetBytes - usedBytes) {
        // A single oversized best hit is truncated so the caller still sees
        // it. The budget is then full. Smaller later rows are tried only
        // when an earlier row was skipped without filling the budget.
        if (chosen.length === 0 && budgetBytes > 0) {
          chosen.push({
            ...entry.memory,
            text: truncateUtf8(entry.memory.text, budgetBytes),
          });
          usedBytes = budgetBytes;
        }
        continue;
      }
      chosen.push(entry.memory);
      usedBytes += size;
    }

    return chosen.map((memory) => decorateMemory(memory, byId));
  }

  /**
   * Store one explicitly recorded decision, lesson, or fact. No Epic comment
   * is written: `record` is a storage operation, not a Jira mutation.
   *
   * @param {RecordInput} input
   * @returns {Promise<RecordResult>}
   */
  async function record(input) {
    const source = assertPlainObject(input, 'record input');
    const projectKey = assertNonEmptyString(
      source.projectKey,
      'record projectKey',
    );
    const epicKey = assertNonEmptyString(source.epicKey, 'record epicKey');
    const text = assertNonEmptyString(source.text, 'record text').trim();
    const type = resolveMemoryType(source, 'record type');
    const scope = normalizeScope(source.scope);
    const validUntil = normalizeValidUntil(source.validUntil);

    const runId =
      source.runId === undefined
        ? undefined
        : assertNonEmptyString(source.runId, 'record runId');

    const store = activeStore();
    const memory = await store.addMemory({
      projectKey,
      scope,
      memType: type,
      text,
      sourceIssue: epicKey,
      runId,
      validUntil,
    });
    if (typeof runId === 'string' && runId.length > 0) {
      await recordEvent(store, {
        runId,
        kind: 'memory.written',
        journalKey: memory.memId,
        detail: {
          memId: memory.memId,
          memType: memory.memType,
          text: String(memory.text ?? '').slice(0, 180),
        },
      });
    }
    return { memId: memory.memId };
  }

  return { writeBack, recall, record };
}

/** Alias matching the short factory name used in the WP6 docs. */
export const createMemory = createMemoryService;

/** @type {ReturnType<typeof createMemoryService>|null} */
let defaultService = null;

/**
 * @returns {ReturnType<typeof createMemoryService>}
 */
function getDefaultService() {
  defaultService ??= createMemoryService();
  return defaultService;
}

/**
 * @param {MemoryDependencies|undefined} deps
 * @returns {ReturnType<typeof createMemoryService>}
 */
function serviceFor(deps) {
  if (deps === undefined || deps === null) {
    return getDefaultService();
  }
  // Accept a bare WP1 store as the third argument for convenience in tests.
  if (typeof deps === 'object') {
    const candidate = /** @type {{getRun?: unknown}} */ (deps);
    if (typeof candidate.getRun === 'function') {
      return createMemoryService({ store: /** @type {any} */ (deps) });
    }
  }
  return createMemoryService(/** @type {MemoryDependencies} */ (deps));
}

/**
 * Write a completed run's summary and decisions back to project memory and
 * enqueue one Epic comment effect.
 *
 * @param {string} runId
 * @param {WriteBackInput} input
 * @param {MemoryDependencies} [deps] Optional dependencies; production uses
 *   WP1's singleton store and lazily loads WP2.
 * @returns {Promise<WriteBackResult>}
 */
export function writeBack(runId, input, deps) {
  return serviceFor(deps).writeBack(runId, input);
}

/**
 * Recall project memories for a goal or query.
 *
 * @param {RecallInput} input
 * @param {MemoryDependencies} [deps]
 * @returns {Promise<import('../store/types.js').Memory[]>}
 */
export function recall(input, deps) {
  return serviceFor(deps).recall(input);
}

/**
 * Store one explicit decision, lesson, or fact.
 *
 * @param {RecordInput} input
 * @param {MemoryDependencies} [deps]
 * @returns {Promise<RecordResult>}
 */
export function record(input, deps) {
  return serviceFor(deps).record(input);
}

/**
 * Drop the module-level effects replacement and cached default service.
 * Tests use this between cases; production does not need it.
 *
 * @returns {void}
 */
export function resetMemory() {
  moduleEffects = null;
  defaultService = null;
}

/**
 * True when the module-level memory service or effects stub is still
 * cached. That cache closes over the store it first saw. The simulator
 * checks this between scenarios and expects `false` after `resetMemory`.
 *
 * @returns {boolean}
 */
export function memoryServiceIsCached() {
  return defaultService !== null || moduleEffects !== null;
}
