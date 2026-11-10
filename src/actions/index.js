/**
 * Rovo action handlers for Ticket Conductor (WP5).
 *
 * Each handler validates input, writes storage or enqueues work, and returns.
 * None of them call the Jira mutation APIs. Child issues, comments, and
 * transitions are effects created later by `startRun` and the workers.
 *
 * Action inputs cannot be arrays, so the plan arrives as `stepsJson`. Unit
 * tests may also pass a `steps` array, which is the same structure after
 * parsing. `record-decision` receives `type` and WP6 stores `memType`.
 *
 * Success objects include `ok: true`. The fields another agent should read
 * are projected in `contract.js`. `actionHandler` turns a throw into
 * `{ ok: false, error, code }` at the Forge boundary (`src/index.js`).
 *
 * @module actions
 */

import { recordEvent } from '../recorder/log.js';
import { forkRun as forkRunImpl } from '../recorder/fork.js';
import { replayRun as replayRunImpl } from '../recorder/replay.js';
import { listWorkerTypes } from '../worker/index.js';
import { normalizePlanGraph } from '../run/graph.js';
import { startRun } from '../run/stateMachine.js';
import { listSkillNames } from '../skills/library.js';
import { prepareStepDraft } from '../skills/brief.js';
import { listSkillIndex } from '../skills/index.js';
import { combineEffectMetrics } from '../effects/metrics.js';
import {
  StoreValidationError,
  createRun,
  createSteps,
  getRun,
  getStore,
  listEffectsByRun,
  listRunsByEpic,
  listSteps,
} from '../store/index.js';
import {
  RECALL_BUDGET_BYTES,
  applyMemoriesToPlan,
  publishPlanCard,
  recall,
  record,
  recordPlanCitations,
} from '../memory/index.js';
import {
  publicMemory,
  publicPlanStep,
  publicRun,
  publicStatusStep,
} from './contract.js';
import { planCardFromSteps, previewBlastRadius } from '../blast/preview.js';
import { confirmationFields } from '../safety/guard.js';
import { authorizeFork } from '../safety/grants.js';
import { applyBlastGate } from '../run/approval.js';
import { readRunBudget } from '../run/budget.js';
import {
  applyBudgetReplan,
  attachStepDuration,
  resolveScheduleNow,
  scheduleFor,
} from '../run/criticalPath.js';

/** Plans stay small enough for one chat confirmation. @constant {number} */
export const MAX_PLAN_STEPS = 8;

/**
 * @param {unknown} error
 * @returns {Error}
 */
function asError(error) {
  if (error instanceof Error) {
    return error;
  }
  return new StoreValidationError(String(error));
}

/**
 * @param {Record<string, unknown>} payload
 * @param {Record<string, unknown>} [context]
 * @returns {string}
 */
function accountId(payload, context) {
  const fromContext = context?.principal?.accountId
    ?? context?.accountId;
  if (typeof fromContext === 'string' && fromContext.length > 0) {
    return fromContext;
  }
  const nested = payload?.context?.accountId;
  if (typeof nested === 'string' && nested.length > 0) {
    return nested;
  }
  return 'unknown';
}

/**
 * Jira context is attached by Rovo when the chat is opened on an issue.
 *
 * @param {Record<string, unknown>} payload
 * @returns {Record<string, unknown>}
 */
function jiraContext(payload) {
  const context = payload?.context;
  if (!context || typeof context !== 'object') {
    return {};
  }
  const jira = /** @type {Record<string, unknown>} */ (context).jira;
  return jira && typeof jira === 'object'
    ? /** @type {Record<string, unknown>} */ (jira)
    : {};
}

/**
 * @param {Record<string, unknown>} payload
 * @param {string} name
 * @param {{required?: boolean, fallback?: unknown}} [options]
 * @returns {string}
 */
function readString(payload, name, options = {}) {
  const value = payload?.[name];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (options.fallback !== undefined && options.fallback !== null) {
    const fallback = String(options.fallback).trim();
    if (fallback.length > 0) {
      return fallback;
    }
  }
  if (options.required === false) {
    return '';
  }
  throw new StoreValidationError(`${name} is required`);
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {string}
 */
function projectKeyFrom(payload) {
  const explicit = payload.projectKey;
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return explicit.trim();
  }
  const fromJira = jiraContext(payload).projectKey;
  if (typeof fromJira === 'string' && fromJira.length > 0) {
    return fromJira;
  }
  const epicKey = typeof payload.epicKey === 'string' ? payload.epicKey : '';
  const prefix = epicKey.split('-')[0];
  if (prefix && prefix !== epicKey) {
    return prefix;
  }
  throw new StoreValidationError('projectKey is required');
}

/**
 * @param {unknown} raw
 * @returns {Array<{title: string, workerType: string, input: any, dependsOn: number[]}>}
 */
export function parsePlanSteps(raw) {
  let steps = raw;
  if (typeof raw === 'string') {
    try {
      steps = JSON.parse(raw);
    } catch (error) {
      throw new StoreValidationError(
        `stepsJson is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!Array.isArray(steps)) {
    throw new StoreValidationError('stepsJson must be a JSON array');
  }
  if (steps.length < 1 || steps.length > MAX_PLAN_STEPS) {
    throw new StoreValidationError(
      `a plan must contain 1 to ${MAX_PLAN_STEPS} steps`,
    );
  }
  const allowed = new Set([...listWorkerTypes(), ...listSkillNames()]);
  const parsed = steps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new StoreValidationError(`steps[${index}] must be an object`);
    }
    const title = typeof step.title === 'string' ? step.title.trim() : '';
    const workerType = typeof step.workerType === 'string' ? step.workerType.trim() : '';
    if (!title) {
      throw new StoreValidationError(`steps[${index}].title is required`);
    }
    if (!allowed.has(workerType)) {
      throw new StoreValidationError(
        `steps[${index}].workerType must be one of ${[...allowed].sort().join(', ')}`,
      );
    }
    // A specific duration is optional. It is not a step attribute. The
    // number is folded into `input` below so KVS keeps it. Omitting it
    // leaves a string input as a string.
    const durationMs = Number.isInteger(step.durationMs) && step.durationMs > 0
      ? step.durationMs
      : undefined;
    return {
      title,
      workerType,
      input: step.input === undefined ? '' : step.input,
      dependsOn: step.dependsOn,
      idx: index,
      ...(durationMs ? { durationMs } : {}),
    };
  });
  // Cycles, self-indexes, and indexes past the end of this plan are rejected
  // here, before `planSplit` creates a run. `idx` is the array position,
  // which is also the idx `createSteps` assigns on a new run.
  return normalizePlanGraph(parsed).map((step) => {
    const attached = attachStepDuration(step);
    return {
      title: attached.title,
      workerType: attached.workerType,
      input: attached.input,
      dependsOn: attached.dependsOn,
    };
  });
}

/**
 * Save a plan. Returns in well under the 55 second action limit.
 *
 * @param {Record<string, unknown>} payload
 * @param {Record<string, unknown>} [context]
 * @param {{now?: () => number}} [overrides] Clock. The simulator passes its
 *   fake clock here. With no clock, the run's own `createdAt` is used so a
 *   test store pinned away from `Date.now()` does not look over budget.
 */
export async function planSplit(payload, context, overrides) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const epicKey = readString(source, 'epicKey', {
    fallback: jiraContext(source).issueKey,
  });
  const goal = readString(source, 'goal');
  const projectKey = projectKeyFrom({ ...source, epicKey });
  const parsed = parsePlanSteps(
    source.steps !== undefined ? source.steps : source.stepsJson,
  );
  // Accepted lessons (and matching memories) change the steps before they
  // are stored. Rejected and proposed lessons are recalled later but do not
  // change the plan. The plan names every id it used. Briefs are built
  // after that, so they see the real dependsOn indexes.
  const plan = await applyMemoriesToPlan({
    projectKey,
    epicKey,
    goal,
    steps: parsed,
    maxSteps: MAX_PLAN_STEPS,
  });
  const run = await createRun({
    epicKey,
    projectKey,
    goal,
    createdBy: accountId(source, context),
  });
  // Blast-radius insertion happens before `createSteps` because `dependsOn`
  // is fixed once the row is stored (`updateStep` will not patch it). The
  // preview ids are temporary. The card returned below is recomputed from
  // the stored rows, so a gate that was just appended shows up as "already
  // in the plan" and is not inserted twice. A 3-step plan is under the
  // threshold, so this adds no KVS write on that path.
  const gated = applyBlastGate({
    run,
    steps: plan.steps,
    planCard: plan.usedLessons.length > 0 ? plan.planCard : '',
  });
  // Join two cheap steps when the critical path (or the step / model-call
  // caps) is over. This has to happen before `createSteps`: `dependsOn` is
  // not patched later. A plan that already fits is returned unchanged, so
  // the usual scenarios do not gain a KVS write. No model call.
  const now = resolveScheduleNow(overrides, run);
  const replan = applyBudgetReplan(
    gated.steps,
    readRunBudget(run.budget, run.createdAt),
    now,
  );
  const drafted = replan.steps.map((step) => prepareStepDraft(step, { goal }));
  const stored = await createSteps(run.runId, drafted);
  const recalledMemories = await recall({
    projectKey,
    epicKey,
    query: goal,
    k: 5,
  });
  const store = getStore();
  await recordPlanCitations({ store, run, plan });
  // The preview is the plan's template writes. It runs before the plan-card
  // comment is enqueued, and it does not call Jira. A memory-only plan has
  // no Epic citation comment, so the card stays quiet unless a lesson was
  // applied. The card is returned to the caller. It is not stored.
  const blastRadius = previewBlastRadius({
    run,
    steps: stored,
    planCard: plan.usedLessons.length > 0 ? plan.planCard : '',
  });
  // The Epic comment is the plan card. It is posted only when a lesson was
  // applied, so a routine decision recall does not add a second comment.
  if (plan.usedLessons.length > 0 && plan.planCard) {
    try {
      const effects = await import('../effects/index.js');
      await publishPlanCard({
        run,
        planCard: plan.planCard,
        enqueueEffect: effects.enqueueEffect,
      });
    } catch {
      // The citation is already stored on the run. A queue failure must not
      // discard the plan.
    }
  }
  await recordEvent(store, {
    runId: run.runId,
    kind: 'plan.created',
    detail: {
      goal,
      epicKey,
      stepCount: stored.length,
      toolName: 'plan-split',
      usedLessons: plan.usedLessons,
      // Only when a pair was actually joined. A plan inside the budget
      // keeps the same detail object it had before this slice, so its
      // event bytes (and every other scenario's KVS cap) stay put.
      // This is not the stall `replan` event.
      ...(replan.applied
        ? {
          budgetReplan: {
            reason: replan.reason,
            mergedIdxs: replan.mergedIdxs,
          },
        }
        : {}),
    },
  });
  for (const step of stored) {
    await recordEvent(store, {
      runId: run.runId,
      kind: 'step.queued',
      stepId: step.stepId,
      stepIdx: step.idx,
      detail: {
        title: step.title,
        workerType: step.workerType,
        dependsOn: step.dependsOn,
      },
    });
  }
  return {
    ok: true,
    runId: run.runId,
    status: run.status,
    epicKey: run.epicKey,
    projectKey: run.projectKey,
    steps: stored.map(publicPlanStep),
    recalledMemories: recalledMemories.map(publicMemory),
    appliedMemories: plan.appliedMemories,
    appliedLessons: plan.appliedLessons,
    usedMemory: plan.usedMemory,
    usedLessons: plan.usedLessons,
    planCard: plan.planCard,
    blastRadius,
    // Ephemeral. The stored run does not grow a critical-path attribute.
    budgetReplan: {
      applied: replan.applied,
      reason: replan.reason,
      mergedIdxs: replan.mergedIdxs,
      criticalPath: replan.criticalPath,
      eta: replan.eta,
      budgetOutlook: replan.budgetOutlook,
    },
    // The acknowledgement is the line a person reads. The confirm token is
    // not on this object. The Run panel mints it.
    ...confirmationFields(blastRadius),
  };
}

/**
 * Start a run after the user confirms. `startRun` is a no-op once the run
 * has left `planning`, which is the dispatch dedupe across retries.
 *
 * @param {Record<string, unknown>} payload
 * @param {Record<string, unknown>} [_context]
 * @param {object} [overrides] Test injection for the state machine.
 */
export async function dispatchRun(payload, _context, overrides) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const runId = readString(source, 'runId');
  // The handler, not the Rovo card, decides. `startRun` recomputes the
  // blast-radius card from the stored steps and refuses the transition
  // unless `confirm` is boolean true and the token matches that card.
  const run = await startRun(runId, {
    ...overrides,
    confirmation: {
      confirm: source.confirm,
      acknowledgeBlastRadius: source.acknowledgeBlastRadius,
      confirmToken: source.confirmToken,
    },
  });
  if (run?.refusedConfirmation) {
    return {
      ok: false,
      code: run.refusedConfirmation.code,
      error: run.refusedConfirmation.reason,
      runId: run.runId,
      status: run.status,
    };
  }
  if (run?.budgetStopped) {
    return {
      ok: false,
      code: 'BUDGET_EXCEEDED',
      error: `run budget exceeded (${run.budgetStopped})`,
      runId: run.runId,
      status: run.status,
    };
  }
  // `startRun` attaches the card only on the planning transition, and only
  // on the object it returns. A repeat dispatch is a no-op and has no card.
  // The panel recomputes one from the steps it already loaded.
  const result = { ok: true, runId: run.runId, status: run.status };
  if (run.blastRadius) {
    result.blastRadius = run.blastRadius;
  }
  return result;
}

/**
 * @param {Record<string, unknown>} payload
 * @param {Record<string, unknown>} [_context]
 * @param {{now?: () => number}} [overrides] Clock for the ETA. The simulator
 *   passes its fake clock. Status does not write the path back to the run.
 */
export async function getRunStatus(payload, _context, overrides) {
  const source = payload && typeof payload === 'object' ? payload : {};
  let run = null;
  if (typeof source.runId === 'string' && source.runId.trim()) {
    run = await getRun(source.runId.trim());
  } else {
    const epicKey = readString(source, 'epicKey', {
      fallback: jiraContext(source).issueKey,
    });
    const runs = await listRunsByEpic(epicKey, { limit: 1 });
    run = runs[0] ?? null;
  }
  // A missing run is still a successful read. Callers branch on `run`.
  if (!run) {
    return { ok: true, run: null, steps: [] };
  }
  const steps = await listSteps(run.runId);
  // Effect rows this handler did not already hold. The query is a read.
  // `applied` and `retried` are counted from `status` and `tries`, so the
  // happy path does not write a counter. `deduped` adds the in-process
  // tally and anything a previous budget write already flushed.
  const effects = await listEffectsByRun(run.runId);
  const effectMetrics = combineEffectMetrics(effects, run.budget, run.runId);
  // Same steps this handler already loaded. `publicStatusStep` drops
  // `input`, so the card is built first. No Jira call.
  const blastRadius = previewBlastRadius({
    run,
    steps,
    planCard: planCardFromSteps(steps),
  });
  const confirmation = run.status === 'planning' ? confirmationFields(blastRadius) : null;
  // Same steps this handler already loaded. The path and the ETA are not
  // stored and they do not add a KVS query. A read never merges steps.
  const schedule = scheduleFor(
    steps,
    readRunBudget(run.budget, run.createdAt),
    resolveScheduleNow(overrides, run),
  );
  return {
    ok: true,
    run: {
      ...publicRun(run),
      criticalPath: schedule.criticalPath,
      eta: schedule.eta,
      budgetOutlook: schedule.budgetOutlook,
      effectMetrics,
    },
    steps: steps.map(publicStatusStep),
    blastRadius,
    ...(confirmation ? confirmation : {}),
  };
}

/**
 * @param {Record<string, unknown>} payload
 */
export async function recallMemory(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const projectKey = readString(source, 'projectKey', {
    fallback: jiraContext(source).projectKey,
  });
  const query = readString(source, 'query');
  // Planner lessons are included only when a person has accepted them and
  // they carry a scope. The byte budget is the same cap plan-split uses.
  // skillIndex is a separate field. Its descriptions are not memories and
  // do not consume RECALL_BUDGET_BYTES.
  const memories = await recall({
    projectKey,
    query,
    k: 5,
    budgetBytes: RECALL_BUDGET_BYTES,
    acceptedLessonsOnly: true,
  });
  const skillIndex = listSkillIndex();
  return { ok: true, memories: memories.map(publicMemory), skillIndex };
}

/**
 * The Rovo input is named `type`. Storage and WP6 persist `memType`.
 *
 * @param {Record<string, unknown>} payload
 */
export async function recordDecision(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const epicKey = readString(source, 'epicKey', {
    fallback: jiraContext(source).issueKey,
  });
  const text = readString(source, 'text');
  const type = readString(source, 'type', {
    required: false,
    fallback: source.memType,
  });
  if (!type) {
    throw new StoreValidationError('type is required');
  }
  const projectKey = projectKeyFrom({ ...source, epicKey });
  const { memId } = await record({
    projectKey,
    epicKey,
    text,
    type,
  });
  return { ok: true, memId };
}

/**
 * Dry-run a past run against today's Jira. Writes nothing.
 *
 * @param {Record<string, unknown>} payload
 * @param {Record<string, unknown>} [_context]
 * @param {object} [overrides]
 */
export async function replayRun(payload, _context, overrides) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const runId = readString(source, 'runId');
  return replayRunImpl(runId, overrides);
}

/**
 * Copy the flight recorder up to a step and re-run only the downstream steps.
 * Pass `input` to edit step N and re-run N as well.
 *
 * @param {Record<string, unknown>} payload
 * @param {Record<string, unknown>} [context]
 * @param {object} [overrides]
 */
export async function forkRun(payload, context, overrides) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const runId = readString(source, 'runId');
  const forkDecision = authorizeFork(
    source,
    typeof overrides?.now === 'function' ? overrides.now() : Date.now(),
  );
  if (!forkDecision.ok) {
    return {
      ok: false,
      code: forkDecision.code,
      error: forkDecision.reason,
      runId,
      status: null,
    };
  }
  const stepIdx = source.stepIdx;
  const createdBy = accountId(source, context);
  /** @type {Record<string, unknown>} */
  const request = { runId, stepIdx, createdBy };
  if (Object.prototype.hasOwnProperty.call(source, 'input') && source.input !== undefined) {
    request.input = source.input;
  }
  return forkRunImpl(request, overrides);
}

/**
 * Action modules surface thrown errors as failed tool calls. Wrap the public
 * handlers only at the Forge boundary if a caller wants a JSON error instead.
 *
 * @param {Function} handler
 * @returns {Function}
 */
export function actionHandler(handler, name = handler.name) {
  return async function wrapped(payload, context) {
    const keys = payload && typeof payload === 'object' ? Object.keys(payload) : [];
    console.log(`[action] ${name} start keys=${keys.join(',')}`);
    try {
      const result = await handler(payload, context);
      console.log(`[action] ${name} ok`);
      return result;
    } catch (error) {
      const normalized = asError(error);
      console.error(`[action] ${name} failed`, error);
      return {
        ok: false,
        error: normalized.message,
        code: /** @type {any} */ (normalized).code ?? 'ERROR',
      };
    }
  };
}
