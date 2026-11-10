/**
 * Planner lessons (WP12 + the ExpeL / mem0 / Graphiti / two-tier notes).
 *
 * A lesson is a memory row of `memType` `lesson`. Humans and the failure
 * hooks change it only through add, edit, upvote, and downvote. An edit or a
 * vote writes a new version and supersedes the old one. A downvote that drops
 * an accepted lesson below one vote expires that version (`validUntil`)
 * instead of deleting it. Replay reads the version whose validity window
 * contains the original run's timestamp.
 *
 * Pools:
 * - `scope: 'project'` or `'epic'` lives on that Jira project
 * - `scope: 'global'` lives in the `__global__` pool and is recalled for
 *   every project, ranked under a same-words project lesson
 *
 * Writes fail closed when `scope` is missing. Reads skip a lesson that has
 * no scope. The planner injects an accepted lesson only when it also has at
 * least one vote, then cites its id. Other memories fill what is left of the
 * 1.5 KB recall budget.
 *
 * A lesson whose text says the step needs a person is a different patch.
 * It appends one `approval` step and points that one step at the gate.
 * It does not prepend `check-deps`, and it does not make the sibling steps
 * wait. The phrases are {@link PERSON_GATE_PATTERN}. A failure lesson such
 * as "missing access to billing-api" does not match, so that path is unchanged.
 *
 * Float fields (`validUntil`, `createdAt`, confidence) are never used as KVS
 * query conditions. The project index is loaded and filtered here.
 *
 * @module memory/lessons
 */

import { getStore, StoreValidationError } from '../store/index.js';
import { scoreMemory } from './scoring.js';
import {
  GLOBAL_PROJECT_KEY,
  LESSON_STATUSES,
  RECALL_BUDGET_BYTES,
  accessCause,
  activeAt,
  buildAppliedText,
  buildLessonText,
  buildPlanCardComment,
  clipText,
  dedupeKeyFor,
  defaultConfidence,
  errorMessageOf,
  isAppliedNote,
  lessonCitation,
  lessonHow,
  lessonOutcome,
  outcomeClause,
  lessonSummary,
  parseApplied,
  parseLesson,
  temporalBounds,
  utf8Size,
} from './lessonText.js';

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new StoreValidationError(`${label} is required`);
  }
  return value.trim();
}

/**
 * Scope is required. `'global'` selects the cross-project pool. `'project'`
 * and `'epic'` stay inside one Jira project. A missing scope is rejected
 * rather than defaulted (fail closed).
 *
 * @param {object} input
 * @returns {{
 *   tier: 'global'|'project',
 *   scope: 'global'|'project'|'epic',
 *   projectKey: string,
 *   storeScope: 'project'|'epic',
 *   epicKey: string
 * }}
 */
function resolvePlacement(input) {
  if (input.scope === undefined || input.scope === null || input.scope === '') {
    throw new StoreValidationError(
      'lesson scope is required (global, project, or epic)',
    );
  }
  const scope = requiredString(input.scope, 'lesson scope');
  if (scope === 'global') {
    return {
      tier: 'global',
      scope: 'global',
      projectKey: GLOBAL_PROJECT_KEY,
      storeScope: 'project',
      epicKey: typeof input.epicKey === 'string' ? input.epicKey.trim() : '',
    };
  }
  if (scope !== 'project' && scope !== 'epic') {
    throw new StoreValidationError(
      'lesson scope must be global, project, or epic',
    );
  }
  const projectKey = requiredString(input.projectKey, 'lesson projectKey');
  const epicKey = typeof input.epicKey === 'string' ? input.epicKey.trim() : '';
  if (scope === 'epic' && epicKey.length === 0) {
    throw new StoreValidationError('epic scope requires epicKey');
  }
  return {
    tier: 'project',
    scope,
    projectKey,
    storeScope: scope,
    epicKey,
  };
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeConfidence(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new StoreValidationError('lesson confidence must be a number from 0 to 1');
  }
  return Math.round(value * 100) / 100;
}

/**
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
function normalizeVotes(value, fallback = 0) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!Number.isInteger(value)) {
    throw new StoreValidationError('lesson votes must be an integer');
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {'proposed'|'accepted'|'rejected'}
 */
function normalizeStatus(value, fallback = 'proposed') {
  if (value === undefined || value === null || value === '') {
    return /** @type {'proposed'|'accepted'|'rejected'} */ (fallback);
  }
  const status = requiredString(value, 'lesson status');
  if (!LESSON_STATUSES.includes(status)) {
    throw new StoreValidationError(
      `lesson status must be one of ${LESSON_STATUSES.join(', ')}`,
    );
  }
  return /** @type {'proposed'|'accepted'|'rejected'} */ (status);
}

/**
 * @param {{store?: import('../store/types.js').Store}} [deps]
 * @returns {import('../store/types.js').Store}
 */
function resolveStore(deps) {
  return deps?.store ?? getStore();
}

/**
 * @param {{now?: () => number}} [deps]
 * @returns {() => number}
 */
function resolveNow(deps) {
  return typeof deps?.now === 'function' ? deps.now : () => Date.now();
}

/**
 * @param {import('../store/types.js').Store} store
 * @param {string} projectKey
 * @returns {Promise<object[]>}
 */
async function loadPools(store, projectKey, options = {}) {
  // Write paths pass fresh: true so a dedupe check never runs on a cached
  // list. Plan-time reads share the store's short per-instance cache.
  const listOptions = options.fresh ? { fresh: true } : undefined;
  const project = await store.listMemoriesByProject(projectKey, listOptions);
  if (projectKey === GLOBAL_PROJECT_KEY) {
    return project;
  }
  const global = await store.listMemoriesByProject(GLOBAL_PROJECT_KEY, listOptions);
  return project.concat(global);
}

/**
 * @param {object[]} memories
 * @returns {Map<string, object>}
 */
function indexById(memories) {
  return new Map(memories.map((memory) => [memory.memId, memory]));
}

/**
 * The next version must sort after every row already stored, even when the
 * test clock is frozen on one millisecond.
 *
 * @param {number} now
 * @param {object[]} memories
 * @returns {number}
 */
function stampAfter(now, memories) {
  let stamp = now;
  for (const memory of memories) {
    if (typeof memory.createdAt === 'number' && memory.createdAt >= stamp) {
      stamp = memory.createdAt + 1;
    }
  }
  return stamp;
}

/**
 * @param {object} memory
 * @param {Map<string, object>} byId
 * @param {number} now
 * @returns {boolean}
 */
function isExpired(memory, byId, now) {
  const { validTo } = temporalBounds(memory, byId);
  return validTo !== 0 && validTo <= now;
}

/**
 * Newest non-superseded lesson with this dedupe key, expired or not.
 * An expired head is still the chain we edit, so a repeat does not fork.
 *
 * @param {object[]} memories
 * @param {string} dedupeKey
 * @returns {object|null}
 */
function headForKey(memories, dedupeKey) {
  /** @type {object|null} */
  let head = null;
  for (const memory of memories) {
    const body = parseLesson(memory);
    if (!body || body.dedupeKey !== dedupeKey || memory.supersededBy) {
      continue;
    }
    if (
      !head ||
      (memory.createdAt ?? 0) > (head.createdAt ?? 0) ||
      (
        (memory.createdAt ?? 0) === (head.createdAt ?? 0) &&
        String(memory.memId) > String(head.memId)
      )
    ) {
      head = memory;
    }
  }
  return head;
}

/**
 * @param {object} memory
 * @param {Map<string, object>} byId
 * @param {number} now
 * @returns {object}
 */
export function toLessonView(memory, byId, now) {
  const body = parseLesson(memory);
  const bounds = temporalBounds(memory, byId);
  const expired = bounds.validTo !== 0 && bounds.validTo <= now;
  return {
    lessonId: memory.memId,
    status: expired ? 'expired' : body.status,
    rawStatus: body.status,
    votes: body.votes,
    confidence: body.confidence,
    scope: body.scope,
    tier: body.tier,
    validFrom: bounds.validFrom,
    validTo: bounds.validTo,
    summary: lessonSummary(memory),
    cause: body.cause,
    goal: body.goal || '',
    kind: body.kind || 'lesson',
    outcome: lessonOutcome(body),
    workerType: typeof body.workerType === 'string' ? body.workerType : '',
    dedupeKey: body.dedupeKey,
    sourceIssue: memory.sourceIssue,
    runId: memory.runId,
    projectKey: memory.projectKey,
    expired,
    patch: body.patch,
  };
}

/**
 * @param {object} params
 * @returns {Promise<object>}
 */
async function writeVersion(params) {
  const {
    store,
    previous,
    summary,
    envelope,
    createdAt,
    validUntil,
    placement,
    runId,
  } = params;
  const memory = await store.addMemory({
    projectKey: placement.projectKey,
    scope: placement.storeScope,
    memType: 'lesson',
    text: buildLessonText(summary, {
      ...envelope,
      validFrom: createdAt,
      validTo: validUntil || 0,
    }),
    sourceIssue: placement.epicKey || undefined,
    runId: runId || undefined,
    validUntil: validUntil || 0,
    createdAt,
  });
  if (previous) {
    await store.supersedeMemory(previous.memId, memory.memId);
  }
  return memory;
}

/**
 * @param {object} memory
 * @param {Map<string, object>} byId
 * @param {number} now
 * @param {string} op
 * @returns {object}
 */
function resultOf(memory, byId, now, op) {
  return { op, ...toLessonView(memory, byId, now) };
}

/**
 * Add a lesson, or dedupe it into the current head.
 *
 * Identical text on a live head is a NOOP. Changed text is an EDIT that
 * keeps votes and status. An expired head is superseded by a fresh proposed
 * version so the history stays one chain.
 *
 * @param {object} input
 * @param {{store?: import('../store/types.js').Store, now?: () => number}} [deps]
 * @returns {Promise<object>}
 */
export async function addLesson(input, deps) {
  const source = input && typeof input === 'object' ? input : {};
  const placement = resolvePlacement(source);
  const text = requiredString(source.text, 'lesson text');
  const cause = typeof source.cause === 'string' && source.cause.trim()
    ? source.cause.trim()
    : text;
  const kind = typeof source.kind === 'string' && source.kind.trim()
    ? source.kind.trim()
    : 'manual';
  const workerType = typeof source.workerType === 'string' ? source.workerType.trim() : '';
  const goal = typeof source.goal === 'string' ? source.goal.trim() : '';
  const outcome = lessonOutcome({ outcome: source.outcome, kind });
  const status = normalizeStatus(source.status, 'proposed');
  const votes = normalizeVotes(source.votes, 0);
  const confidence = normalizeConfidence(source.confidence, 0.55);
  const store = resolveStore(deps);
  const now = resolveNow(deps)();
  const memories = await loadPools(store, placement.projectKey, { fresh: true });
  const dedupeKey = dedupeKeyFor({
    tier: placement.tier,
    projectKey: placement.projectKey,
    kind,
    workerType,
    cause,
  });
  const head = headForKey(memories, dedupeKey);
  const byId = indexById(memories);
  if (head && lessonSummary(head) === text && !isExpired(head, byId, now)) {
    return resultOf(head, byId, now, 'noop');
  }

  const previousBody = head ? parseLesson(head) : null;
  const revive = head && isExpired(head, byId, now);
  const createdAt = stampAfter(now, memories);
  const envelope = {
    v: 1,
    dedupeKey,
    status: revive ? 'proposed' : (head ? previousBody.status : status),
    votes: revive ? 0 : (head ? previousBody.votes : votes),
    confidence: revive ? 0.55 : (head ? previousBody.confidence : confidence),
    tier: placement.tier,
    scope: placement.scope,
    cause,
    goal: goal || previousBody?.goal || '',
    kind,
    outcome,
    workerType,
    patch: source.patch || previousBody?.patch || defaultPatch(cause, placement.epicKey, outcome),
    supersedes: head ? head.memId : undefined,
  };
  const memory = await writeVersion({
    store,
    previous: head,
    summary: text,
    envelope,
    createdAt,
    validUntil: 0,
    placement,
    runId: typeof source.runId === 'string' ? source.runId : head?.runId,
  });
  const nextById = indexById(memories.concat([memory]));
  return resultOf(memory, nextById, createdAt, head && !revive ? 'edit' : 'add');
}

/**
 * @param {string} cause
 * @param {string} epicKey
 * @returns {object}
 */
function defaultPatch(cause, epicKey, outcome = 'blocked') {
  return {
    op: 'prepend-step',
    step: {
      title: `Check dependencies: ${clipText(cause, 72)}`,
      workerType: 'check-deps',
      input: {
        issueKey: epicKey || undefined,
        note: `${capitalize(outcomeClause(cause, outcome))}.`,
      },
    },
  };
}

/**
 * @param {object[]} memories
 * @param {string} lessonId
 * @returns {object}
 */
function requireHead(memories, lessonId) {
  const memory = memories.find((item) => item.memId === lessonId);
  if (!memory || !parseLesson(memory)) {
    throw new StoreValidationError(`lesson ${lessonId} was not found`);
  }
  if (memory.supersededBy) {
    throw new StoreValidationError(
      `lesson ${lessonId} was superseded; edit the current version`,
    );
  }
  return memory;
}

/**
 * @param {object} input
 * @param {{store?: import('../store/types.js').Store, now?: () => number}} [deps]
 * @param {{
 *   status?: string,
 *   votes?: number,
 *   confidence?: number,
 *   text?: string,
 *   expire?: boolean,
 *   op: string
 * }} change
 * @returns {Promise<object>}
 */
async function versionFrom(input, deps, change) {
  const lessonId = requiredString(input.lessonId, 'lessonId');
  const projectKey = requiredString(input.projectKey, 'lesson projectKey');
  const store = resolveStore(deps);
  const now = resolveNow(deps)();
  const memories = await loadPools(store, projectKey, { fresh: true });
  const head = requireHead(memories, lessonId);
  const body = parseLesson(head);
  const summary = typeof change.text === 'string' && change.text.trim()
    ? change.text.trim()
    : lessonSummary(head);
  if (
    change.op === 'edit' &&
    summary === lessonSummary(head) &&
    change.status === undefined &&
    change.votes === undefined
  ) {
    return resultOf(head, indexById(memories), now, 'noop');
  }
  const createdAt = stampAfter(now, memories);
  const placement = {
    projectKey: head.projectKey,
    storeScope: head.scope === 'epic' ? 'epic' : 'project',
    epicKey: typeof head.sourceIssue === 'string' ? head.sourceIssue : '',
    tier: body.tier,
    scope: body.scope,
  };
  const validUntil = change.expire ? createdAt : 0;
  const envelope = {
    ...body,
    status: change.status || body.status,
    votes: change.votes === undefined ? body.votes : change.votes,
    confidence: change.confidence === undefined ? body.confidence : change.confidence,
    cause: body.cause,
    supersedes: head.memId,
  };
  if (typeof input.cause === 'string' && input.cause.trim()) {
    envelope.cause = input.cause.trim();
    envelope.patch = defaultPatch(envelope.cause, placement.epicKey, lessonOutcome(envelope));
  }
  const memory = await writeVersion({
    store,
    previous: head,
    summary,
    envelope,
    createdAt,
    validUntil,
    placement,
    runId: head.runId,
  });
  const nextById = indexById(memories.concat([memory]));
  if (head.supersededBy === undefined) {
    nextById.set(head.memId, { ...head, supersededBy: memory.memId });
  }
  return resultOf(memory, nextById, createdAt, change.op);
}

/**
 * @param {object} input
 * @param {object} [deps]
 */
export async function editLesson(input, deps) {
  const source = input && typeof input === 'object' ? input : {};
  requiredString(source.text, 'lesson text');
  return versionFrom(source, deps, { text: source.text, op: 'edit' });
}

/**
 * @param {object} input
 * @param {object} [deps]
 */
export async function upvoteLesson(input, deps) {
  const source = input && typeof input === 'object' ? input : {};
  const projectKey = requiredString(source.projectKey, 'lesson projectKey');
  const lessonId = requiredString(source.lessonId, 'lessonId');
  const store = resolveStore(deps);
  const memories = await loadPools(store, projectKey, { fresh: true });
  const head = requireHead(memories, lessonId);
  const body = parseLesson(head);
  return versionFrom(source, deps, {
    op: 'upvote',
    votes: body.votes + 1,
    confidence: normalizeConfidence(
      Math.min(0.99, body.confidence + 0.05),
      body.confidence,
    ),
  });
}

/**
 * Downvote. An accepted lesson that falls below one vote is expired, not
 * deleted. A rejected lesson stays visible so a person can still see it.
 *
 * @param {object} input
 * @param {object} [deps]
 */
export async function downvoteLesson(input, deps) {
  const source = input && typeof input === 'object' ? input : {};
  const projectKey = requiredString(source.projectKey, 'lesson projectKey');
  const lessonId = requiredString(source.lessonId, 'lessonId');
  const store = resolveStore(deps);
  const memories = await loadPools(store, projectKey, { fresh: true });
  const head = requireHead(memories, lessonId);
  const body = parseLesson(head);
  const votes = body.votes - 1;
  const expire = body.status === 'accepted' && votes < 1;
  return versionFrom(source, deps, {
    op: 'downvote',
    votes,
    confidence: Math.max(0.05, Math.round((body.confidence - 0.1) * 100) / 100),
    expire,
  });
}

/**
 * Human accept. Counts as one upvote and forces at least one vote, which is
 * the bar the planner requires.
 *
 * @param {object} input
 * @param {object} [deps]
 */
export async function acceptLesson(input, deps) {
  const source = input && typeof input === 'object' ? input : {};
  const projectKey = requiredString(source.projectKey, 'lesson projectKey');
  const lessonId = requiredString(source.lessonId, 'lessonId');
  const store = resolveStore(deps);
  const memories = await loadPools(store, projectKey, { fresh: true });
  const head = requireHead(memories, lessonId);
  const body = parseLesson(head);
  return versionFrom(source, deps, {
    op: 'accept',
    status: 'accepted',
    votes: Math.max(body.votes + 1, 1),
    confidence: Math.max(body.confidence, 0.8),
  });
}

/**
 * Human reject. Counts as one downvote. The row stays active so the Lessons
 * tab can show it, and the planner will not apply it.
 *
 * @param {object} input
 * @param {object} [deps]
 */
export async function rejectLesson(input, deps) {
  const source = input && typeof input === 'object' ? input : {};
  const projectKey = requiredString(source.projectKey, 'lesson projectKey');
  const lessonId = requiredString(source.lessonId, 'lessonId');
  const store = resolveStore(deps);
  const memories = await loadPools(store, projectKey, { fresh: true });
  const head = requireHead(memories, lessonId);
  const body = parseLesson(head);
  return versionFrom(source, deps, {
    op: 'reject',
    status: 'rejected',
    votes: body.votes - 1,
    confidence: Math.max(0.05, Math.round((body.confidence - 0.15) * 100) / 100),
  });
}

/**
 * Panel and tests share one entry point.
 *
 * @param {object} input
 * @param {object} [deps]
 * @returns {Promise<{ok: boolean, error?: string, [key: string]: any}>}
 */
export async function lessonOp(input, deps) {
  const source = input && typeof input === 'object' ? input : {};
  try {
    const op = source.op;
    if (op === 'add') {
      return { ok: true, ...(await addLesson(source, deps)) };
    }
    if (op === 'edit') {
      return { ok: true, ...(await editLesson(source, deps)) };
    }
    if (op === 'upvote') {
      return { ok: true, ...(await upvoteLesson(source, deps)) };
    }
    if (op === 'downvote') {
      return { ok: true, ...(await downvoteLesson(source, deps)) };
    }
    if (op === 'accept') {
      return { ok: true, ...(await acceptLesson(source, deps)) };
    }
    if (op === 'reject') {
      return { ok: true, ...(await rejectLesson(source, deps)) };
    }
    return { ok: false, error: 'unknown lesson op' };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Current heads for the Lessons tab, including expired ones so a person can
 * see that a lesson was expired rather than deleted.
 *
 * @param {object} input
 * @param {object} [deps]
 * @returns {Promise<object[]>}
 */
export async function listLessons(input, deps) {
  const projectKey = requiredString(input?.projectKey, 'lesson projectKey');
  const store = resolveStore(deps);
  const now = resolveNow(deps)();
  const memories = await loadPools(store, projectKey);
  const byId = indexById(memories);
  return memories
    .filter((memory) => parseLesson(memory) && !memory.supersededBy)
    .map((memory) => toLessonView(memory, byId, now))
    .sort((left, right) => right.validFrom - left.validFrom);
}

/**
 * Lessons that held at `asOf`, including versions that were later superseded.
 * This is the replay read. It does not delete or hide history.
 *
 * @param {object} input
 * @param {object} [deps]
 * @returns {Promise<object[]>}
 */
export async function lessonsAt(input, deps) {
  const projectKey = requiredString(input?.projectKey, 'lesson projectKey');
  if (typeof input.asOf !== 'number' || !Number.isFinite(input.asOf)) {
    throw new StoreValidationError('lessonsAt asOf must be an epoch-millisecond number');
  }
  const store = resolveStore(deps);
  const memories = await loadPools(store, projectKey);
  const byId = indexById(memories);
  const query = typeof input.query === 'string' ? input.query : '';
  /** @type {object[]} */
  const matched = [];
  for (const memory of memories) {
    if (!parseLesson(memory) || !activeAt(memory, byId, input.asOf)) {
      continue;
    }
    const view = toLessonView(memory, byId, input.asOf);
    if (query) {
      const score = scoreMemory(
        { text: `${view.summary} ${view.cause} ${view.goal}` },
        query,
      );
      if (score <= 0) {
        continue;
      }
    }
    matched.push(view);
  }
  matched.sort((left, right) => right.validFrom - left.validFrom);
  return matched;
}

/**
 * Record a failure or a watchdog retry as a proposed project lesson.
 * Repeated identical failures dedupe to the existing head.
 *
 * @param {object} input
 * @param {object} [deps]
 * @returns {Promise<object|null>}
 */
export async function recordFailureLesson(input, deps) {
  const source = input && typeof input === 'object' ? input : {};
  const store = source.store && typeof source.store.addMemory === 'function'
    ? source.store
    : resolveStore(deps);
  let run = source.run;
  const step = source.step;
  if (!step || typeof step !== 'object') {
    return null;
  }
  if (!run && typeof step.runId === 'string') {
    run = await store.getRun(step.runId);
  }
  if (!run || typeof run.projectKey !== 'string') {
    return null;
  }
  const title = typeof step.title === 'string' && step.title.trim()
    ? step.title.trim()
    : 'step';
  const workerType = typeof step.workerType === 'string' && step.workerType.trim()
    ? step.workerType.trim()
    : 'research';
  const message = errorMessageOf(source.error);
  const kind = typeof source.kind === 'string' ? source.kind : 'step-failed';
  const status = source.status === 'blocked' ? 'blocked' : 'failed';
  let cause;
  if (kind === 'watchdog-retry') {
    cause = `stuck step "${title}" (${workerType})`;
  } else {
    cause = accessCause(message)
      || `step "${title}" (${workerType}) ${status}: ${clipText(message || 'the step failed', 160)}`;
  }
  const goal = typeof run.goal === 'string' ? run.goal : '';
  const outcome = kind === 'watchdog-retry' ? 'retried' : status;
  const summary = kind === 'watchdog-retry'
    ? `${capitalize(outcomeClause(cause, outcome))} while working on "${goal}". The watchdog retried it.`
    : `${capitalize(outcomeClause(cause, outcome))} while working on "${goal}". Step "${title}" (${workerType}) ${status}: ${clipText(message || cause, 180)}`;
  return addLesson({
    projectKey: run.projectKey,
    scope: 'project',
    epicKey: run.epicKey,
    runId: run.runId,
    text: summary,
    cause,
    goal,
    kind,
    outcome,
    workerType,
    status: 'proposed',
    votes: 0,
    confidence: 0.55,
    patch: defaultPatch(cause, run.epicKey, outcome),
  }, { store, now: resolveNow(deps) });
}

/**
 * @param {object[]} steps
 * @returns {object[]}
 */
function cloneSteps(steps) {
  return steps.map((step) => ({
    ...step,
    dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.slice() : [],
    input: step.input && typeof step.input === 'object' && !Array.isArray(step.input)
      ? { ...step.input }
      : step.input,
  }));
}

/**
 * @param {object} step
 * @returns {number[]}
 */
function depsOf(step) {
  if (!Array.isArray(step?.dependsOn)) {
    return [];
  }
  return step.dependsOn.filter((index) => Number.isInteger(index) && index >= 0);
}

/**
 * @param {object} step
 * @param {number[]} dependsOn
 * @returns {object}
 */
function withDeps(step, dependsOn) {
  const unique = [];
  for (const index of dependsOn) {
    if (!unique.includes(index)) {
      unique.push(index);
    }
  }
  return { ...step, dependsOn: unique };
}

/**
 * Insert the check at index 0. Every later step waits for it, and the
 * indexes those steps already named move up by one.
 *
 * @param {object[]} steps
 * @param {object} check
 * @returns {object[]}
 */
function prependCheck(steps, check) {
  const shifted = steps.map((step) => withDeps(step, [
    0,
    ...depsOf(step).map((index) => index + 1),
  ]));
  return [withDeps(check, []), ...shifted];
}

/**
 * Move an existing check-deps step to index 0 and point every later step
 * at it. The check itself starts immediately, so its old edges are cleared.
 * That avoids a cycle where the check waited on a step that now waits on it.
 *
 * @param {object[]} steps
 * @param {number} from
 * @returns {object[]}
 */
function moveCheckToFront(steps, from) {
  /** @type {Map<number, number>} */
  const map = new Map();
  map.set(from, 0);
  let cursor = 1;
  for (let index = 0; index < steps.length; index += 1) {
    if (index === from) {
      continue;
    }
    map.set(index, cursor);
    cursor += 1;
  }
  const ordered = [steps[from], ...steps.filter((_, index) => index !== from)];
  return ordered.map((step, index) => {
    if (index === 0) {
      return withDeps(step, []);
    }
    const oldIndex = steps.indexOf(step);
    const dependsOn = [0];
    for (const dep of depsOf(steps[oldIndex])) {
      const next = map.get(dep);
      if (next !== undefined && next !== index) {
        dependsOn.push(next);
      }
    }
    return withDeps(step, dependsOn);
  });
}

/**
 * @param {unknown} input
 * @param {string} line
 * @returns {unknown}
 */
function appendLine(input, line) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const notes = Array.isArray(input.memoryNotes) ? input.memoryNotes.slice() : [];
    notes.push(line);
    return { ...input, memoryNotes: notes };
  }
  const base = input === undefined || input === null ? '' : String(input);
  return `${base}${base ? '\n' : ''}${line}`;
}

/**
 * @param {unknown} input
 * @param {{lessonId: string, citation: string}} citation
 * @returns {unknown}
 */
function appendCitation(input, citation) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const citations = Array.isArray(input.citations) ? input.citations.slice() : [];
    citations.push(citation.citation);
    return {
      ...input,
      lessonId: input.lessonId || citation.lessonId,
      citation: input.citation || citation.citation,
      citations,
    };
  }
  return appendLine(input, citation.citation);
}

/**
 * Phrases that mean a person has to approve one step. Matched on the
 * lesson summary, cause, goal, and worker type. Failure lessons the
 * planner already writes ("missing access to billing-api") do not contain
 * these, so they still prepend `check-deps`.
 *
 * @constant {RegExp}
 */
export const PERSON_GATE_PATTERN = /needs a person|needs approval|human approval|ask a person/i;

/**
 * True when an accepted lesson is a "ask a person" policy.
 *
 * @param {{summary?: string, cause?: string, goal?: string, text?: string, workerType?: string}|null|undefined} lesson
 * @returns {boolean}
 */
export function lessonAsksForPerson(lesson) {
  if (!lesson || typeof lesson !== 'object') {
    return false;
  }
  const blob = [lesson.summary, lesson.text, lesson.cause, lesson.goal, lesson.workerType]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join('\n');
  return PERSON_GATE_PATTERN.test(blob);
}

/**
 * Worker types a person-lesson may name. Longer names are listed first so
 * a search for the earliest mention cannot clip `check-deps` into `deps`.
 *
 * @constant {ReadonlyArray<string>}
 */
const PERSON_GATE_WORKERS = Object.freeze([
  'draft-spec',
  'check-deps',
  'risk-review',
  'test-plan',
  'research',
]);

/**
 * Which step the person has to approve. An explicit `workerType` on the
 * lesson wins. Otherwise the earliest worker name in the prose wins. If
 * the lesson does not name one, the first step that is not itself a gate
 * is the target, and the siblings stay free of the new edge.
 *
 * @param {object[]} steps
 * @param {object} lesson
 * @returns {number} Array index, or -1 when there is nothing to gate.
 */
function personGateTarget(steps, lesson) {
  const named = typeof lesson.workerType === 'string' ? lesson.workerType.trim() : '';
  if (named && named !== 'approval' && named !== 'summarize') {
    const found = steps.findIndex((step) => step.workerType === named);
    if (found >= 0) {
      return found;
    }
  }
  const blob = `${lesson.cause || ''}\n${lesson.summary || ''}`.toLowerCase();
  let best = -1;
  let bestAt = Number.POSITIVE_INFINITY;
  for (const type of PERSON_GATE_WORKERS) {
    const at = blob.indexOf(type);
    if (at < 0 || at >= bestAt) {
      continue;
    }
    const found = steps.findIndex((step) => step.workerType === type);
    if (found >= 0) {
      best = found;
      bestAt = at;
    }
  }
  if (best >= 0) {
    return best;
  }
  return steps.findIndex(
    (step) => step.workerType !== 'approval' && step.workerType !== 'summarize',
  );
}

/**
 * @param {object} lesson
 * @param {string} how
 * @param {string} citation
 * @returns {object}
 */
function appliedLessonRecord(lesson, how, citation) {
  return {
    lessonId: lesson.lessonId,
    memId: lesson.lessonId,
    kind: 'lesson',
    memType: 'lesson',
    text: lesson.summary,
    how,
    citation,
    confidence: lesson.confidence,
    scope: lesson.scope,
    tier: lesson.tier,
  };
}

/**
 * Append one approval gate and point a single step at it.
 *
 * The new step goes at the end. Existing indexes do not move, which is the
 * same rule as `gateInsertion` in the blast-radius preview. A plan that is
 * already at `maxSteps` is not grown: the citation is written onto the
 * target step and no gate is added.
 *
 * @param {object[]} steps
 * @param {object} lesson
 * @param {{epicKey: string, maxSteps: number, prepended: boolean}} ctx
 * @returns {{steps: object[], prepended: boolean, applied: object}|null}
 */
function applyPersonGate(steps, lesson, ctx) {
  const targetIndex = personGateTarget(steps, lesson);
  if (targetIndex < 0) {
    return null;
  }
  const target = steps[targetIndex];
  const cause = lesson.cause || lesson.summary;
  const how = `${outcomeClause(cause, lessonOutcome(lesson))}, so a person must approve "${clipText(target.title, 80)}" before that step starts`;
  const citation = lessonCitation(lesson, how);
  const applied = appliedLessonRecord(lesson, how, citation);
  const existing = steps.findIndex((step) => step.workerType === 'approval');

  if (existing === -1 && steps.length >= ctx.maxSteps) {
    const capped = steps.slice();
    capped[targetIndex] = {
      ...target,
      input: appendCitation(target.input, { lessonId: lesson.lessonId, citation }),
    };
    return { steps: capped, prepended: ctx.prepended, applied };
  }

  let next = steps;
  let gateIdx = existing;
  if (existing === -1) {
    gateIdx = steps.length;
    next = steps.concat([{
      title: `Approve: ${clipText(target.title, 72)}`,
      workerType: 'approval',
      dependsOn: [],
      input: {
        reason: citation,
        lessonId: lesson.lessonId,
        citation,
        targetIdx: targetIndex,
      },
    }]);
  } else if (depsOf(steps[existing]).includes(targetIndex)) {
    // The gate already waits on the target. Pointing the target back at
    // the gate would be a cycle, which `plan-split` rejects. Cite only.
    const cited = steps.slice();
    cited[targetIndex] = {
      ...target,
      input: appendCitation(target.input, { lessonId: lesson.lessonId, citation }),
    };
    return { steps: cited, prepended: ctx.prepended, applied };
  }

  const patched = next.map((step, index) => {
    if (index !== targetIndex) {
      return step;
    }
    return withDeps(step, [...depsOf(step), gateIdx]);
  });
  if (existing !== -1) {
    const gate = patched[existing];
    patched[existing] = {
      ...gate,
      input: appendCitation(gate.input, { lessonId: lesson.lessonId, citation }),
    };
  }
  // `prepended` stays as it was. A later failure lesson can still move a
  // check-deps step to the front. That shift rewrites indexes, including
  // the new gate index, inside `prependCheck`.
  return { steps: patched, prepended: ctx.prepended, applied };
}

/**
 * @param {object[]} steps
 * @param {object} lesson
 * @param {{epicKey: string, maxSteps: number, prepended: boolean}} ctx
 * @returns {{steps: object[], prepended: boolean, applied: object}|null}
 */
function applyOneLesson(steps, lesson, ctx) {
  if (!lesson.scope) {
    return null;
  }
  if (lessonAsksForPerson(lesson)) {
    return applyPersonGate(cloneSteps(steps), lesson, ctx);
  }
  const cause = lesson.cause || lesson.summary;
  let next = cloneSteps(steps);
  const existingIndex = next.findIndex((step) => step.workerType === 'check-deps');
  const existing = existingIndex === -1 ? null : next[existingIndex];
  /** @type {'prepend'|'annotate'|'full'|'moved'} */
  let mode = 'prepend';
  if (ctx.prepended || existing) {
    mode = 'annotate';
    if (existing && !ctx.prepended && existingIndex !== 0) {
      mode = 'moved';
    }
  } else if (next.length >= ctx.maxSteps) {
    mode = 'full';
  }
  const outcome = lessonOutcome(lesson);
  const how = lessonHow(cause, mode, outcome);
  const citation = lessonCitation(lesson, how);
  if (mode === 'prepend') {
    next = prependCheck(next, {
      title: `Check dependencies: ${clipText(cause, 72)}`,
      workerType: 'check-deps',
      input: {
        issueKey: ctx.epicKey,
        lessonId: lesson.lessonId,
        citation,
        note: `${capitalize(outcomeClause(cause, outcome))}.`,
      },
    });
  } else if (mode === 'moved' && existing) {
    next[existingIndex] = {
      ...existing,
      input: appendCitation(existing.input, { lessonId: lesson.lessonId, citation }),
    };
    next = moveCheckToFront(next, existingIndex);
  } else {
    const target = (mode === 'full'
      ? next[0]
      : next.find((step) => step.workerType === 'check-deps')) || next[0];
    target.input = appendCitation(target.input, {
      lessonId: lesson.lessonId,
      citation,
    });
  }
  return {
    steps: next,
    prepended: mode === 'prepend' || mode === 'moved' || ctx.prepended,
    applied: {
      lessonId: lesson.lessonId,
      memId: lesson.lessonId,
      kind: 'lesson',
      memType: 'lesson',
      text: lesson.summary,
      how,
      citation,
      confidence: lesson.confidence,
      scope: lesson.scope,
      tier: lesson.tier,
    },
  };
}

/**
 * Recall accepted lessons and matching memories, then change the plan.
 * Rejected, proposed, expired, and zero-vote lessons are not applied.
 * The returned plan names every id it used.
 *
 * @param {object} input
 * @param {object} [deps]
 * @returns {Promise<object>}
 */
export async function applyMemoriesToPlan(input, deps) {
  const source = input && typeof input === 'object' ? input : {};
  const projectKey = requiredString(source.projectKey, 'projectKey');
  const epicKey = requiredString(source.epicKey, 'epicKey');
  const goal = requiredString(source.goal, 'goal');
  const steps = Array.isArray(source.steps) ? source.steps : [];
  const maxSteps = Number.isInteger(source.maxSteps) ? source.maxSteps : 8;
  const store = resolveStore(deps);
  const now = resolveNow(deps)();
  const memories = await loadPools(store, projectKey);
  const byId = indexById(memories);

  const rankedLessons = memories
    .filter((memory) => parseLesson(memory) && !memory.supersededBy)
    .map((memory) => toLessonView(memory, byId, now))
    .filter((lesson) => (
      lesson.rawStatus === 'accepted' &&
      lesson.votes >= 1 &&
      !lesson.expired &&
      lesson.scope &&
      scoreMemory(
        { text: `${lesson.summary} ${lesson.cause} ${lesson.goal}` },
        goal,
      ) > 0
    ))
    .map((lesson) => {
      let score = scoreMemory(
        { text: `${lesson.summary} ${lesson.cause} ${lesson.goal}` },
        goal,
      );
      if (lesson.tier === 'project') {
        score += 1;
      }
      if (lesson.sourceIssue === epicKey) {
        score += 1.5;
      }
      score += Number(lesson.confidence) || 0;
      return { lesson, score };
    })
    .sort((left, right) => right.score - left.score || right.lesson.validFrom - left.lesson.validFrom);

  let planned = cloneSteps(steps);
  let prepended = false;
  /** @type {object[]} */
  const appliedLessons = [];
  let usedBytes = 0;
  for (const entry of rankedLessons) {
    const previewHow = lessonHow(entry.lesson.cause || entry.lesson.summary, 'prepend', lessonOutcome(entry.lesson));
    const preview = lessonCitation(entry.lesson, previewHow);
    const size = utf8Size(preview);
    if (appliedLessons.length > 0 && usedBytes + size > RECALL_BUDGET_BYTES) {
      continue;
    }
    const applied = applyOneLesson(planned, entry.lesson, {
      epicKey,
      maxSteps,
      prepended,
    });
    if (!applied) {
      continue;
    }
    planned = applied.steps;
    prepended = applied.prepended;
    appliedLessons.push(applied.applied);
    usedBytes += utf8Size(applied.applied.citation);
    if (appliedLessons.length === 1 && size > RECALL_BUDGET_BYTES) {
      break;
    }
  }

  const rankedMemories = [];
  for (const memory of memories) {
    if (memory.supersededBy || isAppliedNote(memory) || parseLesson(memory)) {
      continue;
    }
    if (!memory.scope) {
      continue;
    }
    if (typeof memory.validUntil === 'number' && memory.validUntil !== 0 && memory.validUntil <= now) {
      continue;
    }
    const score = scoreMemory(memory, goal);
    if (score <= 0) {
      continue;
    }
    let ranked = score;
    if (memory.projectKey === GLOBAL_PROJECT_KEY) {
      ranked *= 0.9;
    } else {
      ranked += 0.25;
    }
    if (memory.sourceIssue === epicKey) {
      ranked += 1.5;
    }
    rankedMemories.push({ memory, score: ranked });
  }
  rankedMemories.sort((left, right) => (
    right.score - left.score ||
    (right.memory.createdAt ?? 0) - (left.memory.createdAt ?? 0)
  ));

  /** @type {object[]} */
  const appliedMemories = [];
  for (const entry of rankedMemories) {
    const confidence = defaultConfidence(entry.memory.memType);
    const tier = entry.memory.projectKey === GLOBAL_PROJECT_KEY ? 'global' : 'project';
    const line = `Memory ${entry.memory.memId} (confidence ${confidence.toFixed(2)}, scope ${entry.memory.scope}): ${clipText(entry.memory.text, 180)}`;
    if (usedBytes + utf8Size(line) > RECALL_BUDGET_BYTES) {
      continue;
    }
    const target = planned.find((step) => step.workerType === 'draft-spec')
      || [...planned].reverse().find((step) => step.workerType !== 'check-deps')
      || planned[0];
    if (!target) {
      break;
    }
    target.input = appendLine(target.input, line);
    usedBytes += utf8Size(line);
    const how = `applied memory ${entry.memory.memId} (confidence ${confidence.toFixed(2)}, scope ${entry.memory.scope}) by adding it as a constraint on "${target.title}"`;
    appliedMemories.push({
      memId: entry.memory.memId,
      kind: 'memory',
      memType: entry.memory.memType,
      text: entry.memory.text,
      how,
      citation: how,
      confidence,
      scope: entry.memory.scope,
      tier,
    });
  }

  const usedLessons = appliedLessons.map((lesson) => lesson.lessonId);
  const usedMemory = appliedMemories.map((memory) => memory.memId);
  const lines = [];
  if (usedLessons.length > 0) {
    lines.push(`Used lessons: ${usedLessons.join(', ')}`);
    for (const lesson of appliedLessons) {
      lines.push(lesson.citation);
    }
  }
  if (usedMemory.length > 0) {
    lines.push(`Used memories: ${usedMemory.join(', ')}`);
  }
  return {
    steps: planned,
    appliedLessons,
    appliedMemories,
    usedLessons,
    usedMemory,
    planCard: lines.join('\n'),
  };
}

/**
 * Persist the citations on the new run so the Recall tab can show them
 * after the action response is gone.
 *
 * @param {object} input
 * @returns {Promise<string[]>}
 */
export async function recordPlanCitations(input) {
  const store = input.store ?? getStore();
  const { run, plan } = input;
  const items = [
    ...(plan.appliedLessons || []),
    ...(plan.appliedMemories || []),
  ];
  /** @type {string[]} */
  const ids = [];
  for (const item of items) {
    const memory = await store.addMemory({
      projectKey: run.projectKey,
      scope: 'project',
      memType: 'fact',
      text: buildAppliedText({
        lessonId: item.lessonId,
        memId: item.memId || item.lessonId,
        kind: item.kind || (item.lessonId ? 'lesson' : 'memory'),
        how: item.how,
        citation: item.citation || item.how,
        confidence: item.confidence,
        scope: item.scope,
        tier: item.tier,
        text: item.text,
      }),
      sourceIssue: run.epicKey,
      runId: run.runId,
      validUntil: 0,
    });
    ids.push(memory.memId);
  }
  return ids;
}

/**
 * Epic comment that cites the lessons this plan used. One comment per run;
 * the discriminator is stable, so a retry does not post a second one.
 *
 * @param {object} input
 * @returns {Promise<{requestKey: string, created: boolean}|null>}
 */
export async function publishPlanCard(input) {
  const { run, planCard, enqueueEffect } = input;
  if (!planCard || typeof enqueueEffect !== 'function') {
    return null;
  }
  const comment = buildPlanCardComment(planCard);
  try {
    return await enqueueEffect({
      runId: run.runId,
      stepId: null,
      kind: 'comment',
      payload: {
        issueKey: run.epicKey,
        bodyText: comment.bodyText,
        bodyAdf: comment.bodyAdf,
      },
      discriminator: 'plan:lesson-citation',
    });
  } catch {
    return null;
  }
}

/**
 * Split a run's memories for the panel: ordinary memories, the recall
 * citations, and the lesson heads.
 *
 * @param {import('../store/types.js').Store} store
 * @param {object} run
 * @param {number} [now]
 * @returns {Promise<object>}
 */
export async function describeRunMemory(store, run, now = Date.now()) {
  const memories = await loadPools(store, run.projectKey);
  const byId = indexById(memories);
  const lessons = memories
    .filter((memory) => parseLesson(memory) && !memory.supersededBy)
    .map((memory) => toLessonView(memory, byId, now))
    .sort((left, right) => right.validFrom - left.validFrom);
  const appliedMemories = memories
    .filter((memory) => memory.runId === run.runId && isAppliedNote(memory))
    .map((memory) => parseApplied(memory))
    .filter(Boolean);
  return finishRunMemory(run, memories, lessons, appliedMemories);
}

/**
 * @param {object} run
 * @param {object[]} memories
 * @param {object[]} lessons
 * @param {object[]} appliedMemories
 */
function finishRunMemory(run, memories, lessons, appliedMemories) {
  const visible = memories.filter((memory) => (
    memory.projectKey === run.projectKey &&
    (memory.runId === run.runId || memory.sourceIssue === run.epicKey) &&
    !isAppliedNote(memory) &&
    !parseLesson(memory)
  ));
  const planLines = appliedMemories
    .filter((item) => item.kind === 'lesson' && item.citation)
    .map((item) => item.citation);
  const usedLessons = appliedMemories
    .filter((item) => item.kind === 'lesson')
    .map((item) => item.lessonId)
    .filter(Boolean);
  const usedMemory = appliedMemories
    .filter((item) => item.kind === 'memory')
    .map((item) => item.memId)
    .filter(Boolean);
  return {
    memories: visible,
    lessons,
    appliedMemories,
    planCard: planLines.join('\n'),
    usedLessons,
    usedMemory,
  };
}

/** @param {string} text @returns {string} */
function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
