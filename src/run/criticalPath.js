/**
 * Critical path, ETA, and the budget re-plan (novelty #6, second slice).
 *
 * The first slice (`budget.js`) only records caps and usage on `run.budget`.
 * This module does not add a Forge entity, a scope, or a queue, and it does
 * not add an attribute. Forge rejects an undeclared attribute with a bare
 * 422, and it also rejects deleting one that already shipped, so the path
 * and the ETA stay off the stored row.
 *
 * What is computed
 * ----------------
 * `dependsOn` is a list of step indexes that must finish first. The critical
 * path is the longest chain of remaining work through that DAG. Each step
 * contributes the 12 minute step deadline (`STEP_DEADLINE_MS`), unless the
 * step already carries a positive integer `durationMs` on itself or on
 * `input.durationMs`. `input` is an existing `any` attribute, so a specific
 * duration round-trips without a manifest change.
 *
 * `summarize` is not a work step. It adds nothing to the path and nothing
 * to the step cap. An approval gate is work: while it is not `done` it
 * still blocks every step that lists it, and the ETA includes its deadline.
 * A `done` step adds nothing. A `running` step with no specific duration
 * contributes the time left until `deadlineAt`, or one full deadline when
 * that clock has already passed (the watchdog will try again).
 *
 * The ETA is the remaining path length and the absolute finish
 * (`now + remaining`). `now` is the caller's clock. The simulator passes
 * its fake clock. A production read with no clock uses `Date.now()` when
 * that clock is close to the budget's own clock, and the budget clock
 * otherwise, so a unit test pinned to 2023 does not look centuries over.
 *
 * When the projection is over
 * ---------------------------
 * Over means any of:
 * - elapsed time plus the critical path is greater than `wallClockMs`
 *   (equal to the cap is still inside; eight serial default steps fit);
 * - `usedSteps`, plus work steps that are not stored yet, is greater than
 *   `maxSteps`;
 * - `usedModelCalls`, plus one call for each remaining step that is not an
 *   approval gate, is greater than `maxModelCalls`.
 *
 * `plan-split` calls `applyBudgetReplan` once, before `createSteps`.
 * `dependsOn` cannot be patched after the row is stored, so this is the
 * moment the plan can still shrink. The merge is deterministic and does
 * not call a model (`CONDUCTOR_LLM` stays off). It joins two cheap steps
 * (duration at most one deadline) that share a `workerType`, or that sit
 * on a direct `dependsOn` edge. The merged step keeps the upstream
 * worker type, one deadline (the longer of the two, not the sum), and a
 * title that names both. One call merges one pair. If that pair is not
 * enough, the shorter plan is still stored and the reason says so.
 *
 * If no pair would shorten the thing that is over, the plan is unchanged.
 * The reason is `no-cheap-pair` or `merge-would-not-help`. Nothing is
 * invented to fill the gap.
 *
 * This is not the Magentic-One stall re-plan in `src/recorder/replan.js`.
 * That one logs a `replan` event after two stalls and does not edit the
 * stored plan. This one edits the plan before it is stored and does not
 * write kind `replan`.
 *
 * The panel badge that draws this path is still the 2026-11-28 slice.
 * `get-run-status` and the panel data loader only attach the numbers.
 *
 * @module run/criticalPath
 */

import { countAddedWorkSteps, RUN_MAX_MODEL_CALLS, RUN_MAX_STEPS, RUN_WALL_CLOCK_MS } from './budget.js';
import { STEP_DEADLINE_MS } from './dependencies.js';

/** The plan fits. No steps were joined. @constant {string} */
export const REPLAN_WITHIN_BUDGET = 'within-budget';

/** Two cheap steps were joined and the projection now fits. @constant {string} */
export const REPLAN_MERGED = 'merged';

/**
 * Two cheap steps were joined and the projection is still over.
 * The stored plan is the shorter one. A second call may join another pair.
 * @constant {string}
 */
export const REPLAN_MERGED_STILL_OVER = 'merged-still-over';

/** No two cheap steps are allowed to join. @constant {string} */
export const REPLAN_NO_PAIR = 'no-cheap-pair';

/**
 * Cheap steps exist, but joining any pair would not shorten the cap that
 * is over (usually the critical path). The plan is left alone.
 * @constant {string}
 */
export const REPLAN_NO_HELP = 'merge-would-not-help';

/** Projected finish is past `wallClockMs`. @constant {string} */
export const OVER_WALL = 'wall-clock';

/** Projected work-step count is past `maxSteps`. @constant {string} */
export const OVER_STEPS = 'steps';

/** Projected model calls are past `maxModelCalls`. @constant {string} */
export const OVER_CALLS = 'model-calls';

/**
 * A step is cheap when its planned duration is one deadline or less.
 * An expensive step (a longer `durationMs`) stays whole so the ETA does
 * not pretend that work got shorter.
 *
 * @param {object|null|undefined} step
 * @returns {boolean}
 */
function isCheap(step) {
  const duration = plannedDurationMs(step);
  return duration > 0 && duration <= STEP_DEADLINE_MS;
}

/**
 * Steps the merger is allowed to consume.
 * Approval stays a gate. Summarize is not work. A step that has started,
 * finished, or failed is not rewritten: its child issue may already exist.
 * A draft has no `status` yet, and a draft is the case `plan-split` merges.
 *
 * @param {object|null|undefined} step
 * @returns {boolean}
 */
function isMergeable(step) {
  if (!step || typeof step !== 'object') return false;
  if (step.workerType === 'summarize' || step.workerType === 'approval') return false;
  if (
    step.status === 'done'
    || step.status === 'running'
    || step.status === 'failed'
    || step.status === 'blocked'
  ) {
    return false;
  }
  return isCheap(step);
}

/**
 * Positive integer duration a planner already put on the step.
 * Anything else (missing, zero, a float, a string) means "use the deadline".
 *
 * @param {object|null|undefined} step
 * @returns {number|null}
 */
export function readCustomDurationMs(step) {
  if (!step || typeof step !== 'object') return null;
  if (Number.isInteger(step.durationMs) && step.durationMs > 0) {
    return step.durationMs;
  }
  const input = step.input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    if (Number.isInteger(input.durationMs) && input.durationMs > 0) {
      return input.durationMs;
    }
  }
  return null;
}

/**
 * How long the planner says this step takes, ignoring status.
 * Summarize is zero. Every other step is its specific duration or one
 * deadline. The step cap does not use this number; the path does.
 *
 * @param {object|null|undefined} step
 * @returns {number}
 */
export function plannedDurationMs(step) {
  if (!step || step.workerType === 'summarize') return 0;
  const custom = readCustomDurationMs(step);
  return custom == null ? STEP_DEADLINE_MS : custom;
}

/**
 * Work still ahead of this step.
 * `done` and `summarize` are zero, so they fall out of the reported path.
 * A running step that already has `deadlineAt` counts only the time left
 * on that clock, unless the planner set a specific duration (that estimate
 * stands, because the watchdog deadline is always 12 minutes and does not
 * know about the estimate).
 *
 * @param {object|null|undefined} step
 * @param {number} now
 * @returns {number}
 */
export function remainingWorkMs(step, now) {
  if (!step || step.workerType === 'summarize') return 0;
  if (step.status === 'done') return 0;
  const custom = readCustomDurationMs(step);
  if (custom != null) return custom;
  if (step.status === 'running' && Number.isFinite(step.deadlineAt) && Number.isFinite(now)) {
    const left = step.deadlineAt - now;
    if (left > 0) return left;
    // The deadline passed and the step is still running. The watchdog
    // gives it another full deadline. Counting zero would hide the work.
    return STEP_DEADLINE_MS;
  }
  return STEP_DEADLINE_MS;
}

/**
 * Copy a plan into indexes and `dependsOn` arrays this module can read.
 * A missing `idx` is the array position, which is how a plan looks before
 * `createSteps` assigns indexes. The caller's objects are not modified.
 *
 * @param {Array<object>|null|undefined} steps
 * @returns {object[]}
 */
function indexSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.map((step, position) => {
    const source = step && typeof step === 'object' ? step : {};
    const dependsOn = Array.isArray(source.dependsOn)
      ? source.dependsOn.filter((idx) => Number.isInteger(idx) && idx >= 0)
      : [];
    return {
      ...source,
      idx: Number.isInteger(source.idx) ? source.idx : position,
      dependsOn,
    };
  });
}

/**
 * @param {number[]} values
 * @returns {number[]}
 */
function dedupe(values) {
  /** @type {number[]} */
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (!Number.isInteger(value) || value < 0 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/**
 * Longer path wins. An equal length keeps the lexicographically smaller
 * index list, so two diamonds of the same duration always pick the same
 * chain (the one that starts at the lower index).
 *
 * @param {{durationMs: number, indexes: number[]}} candidate
 * @param {{durationMs: number, indexes: number[]}} current
 * @returns {boolean}
 */
function betterPath(candidate, current) {
  if (candidate.durationMs !== current.durationMs) {
    return candidate.durationMs > current.durationMs;
  }
  const left = candidate.indexes;
  const right = current.indexes;
  const length = Math.min(left.length, right.length);
  for (let position = 0; position < length; position += 1) {
    if (left[position] !== right[position]) return left[position] < right[position];
  }
  return left.length < right.length;
}

/**
 * Longest chain of remaining work.
 *
 * The walk follows `dependsOn` backwards (those indexes run first) and
 * the returned `indexes` run forwards, root first. `keys` are the `stepId`s
 * in that same order. A step that has not been stored yet contributes `''`.
 * `durationMs` is the sum of {@link remainingWorkMs} along the chain.
 *
 * @param {Array<object>|null|undefined} steps
 * @param {number} [now]
 * @returns {{indexes: number[], keys: string[], durationMs: number}}
 */
export function criticalPathOf(steps, now = 0) {
  const indexed = indexSteps(steps);
  const byIdx = new Map(indexed.map((step) => [step.idx, step]));
  /** @type {Map<number, {durationMs: number, indexes: number[]}>} */
  const memo = new Map();

  /**
   * @param {number} idx
   * @param {Set<number>} stack
   * @returns {{durationMs: number, indexes: number[]}}
   */
  function compute(idx, stack) {
    const cached = memo.get(idx);
    if (cached) return cached;
    const step = byIdx.get(idx);
    if (!step || stack.has(idx)) {
      return { durationMs: 0, indexes: [] };
    }
    const self = remainingWorkMs(step, now);
    stack.add(idx);
    // A zero-length step (done, or summarize) does not appear in the
    // index list. Its upstream chain is still visible to whatever waits
    // on it, which is how an approval that is already `done` drops out
    // while the draft behind it stays.
    /** @type {{durationMs: number, indexes: number[]}} */
    let best = {
      durationMs: self,
      indexes: self > 0 ? [idx] : [],
    };
    const deps = step.dependsOn.filter((dep) => byIdx.has(dep)).sort((left, right) => left - right);
    for (const dep of deps) {
      const upstream = compute(dep, stack);
      const candidate = {
        durationMs: upstream.durationMs + self,
        indexes: self > 0 ? [...upstream.indexes, idx] : [...upstream.indexes],
      };
      if (betterPath(candidate, best)) best = candidate;
    }
    stack.delete(idx);
    memo.set(idx, best);
    return best;
  }

  /** @type {{durationMs: number, indexes: number[]}} */
  let best = { durationMs: 0, indexes: [] };
  for (const step of indexed) {
    const path = compute(step.idx, new Set());
    if (betterPath(path, best)) best = path;
  }

  return {
    indexes: best.indexes,
    keys: best.indexes.map((idx) => {
      const step = byIdx.get(idx);
      return typeof step?.stepId === 'string' && step.stepId ? step.stepId : '';
    }),
    durationMs: best.durationMs,
  };
}

/**
 * Caps from the stored budget, with the module defaults when a field is
 * missing. A test may pass a tighter cap. Production passes `readRunBudget`,
 * whose caps are the real constants.
 *
 * @param {object|null|undefined} budget
 */
function capsOf(budget) {
  const source = budget && typeof budget === 'object' ? budget : {};
  const integer = (value, fallback) => (Number.isInteger(value) && value >= 0 ? value : fallback);
  return {
    maxSteps: integer(source.maxSteps, RUN_MAX_STEPS),
    maxModelCalls: integer(source.maxModelCalls, RUN_MAX_MODEL_CALLS),
    wallClockMs: integer(source.wallClockMs, RUN_WALL_CLOCK_MS),
    usedSteps: integer(source.usedSteps, 0),
    usedModelCalls: integer(source.usedModelCalls, 0),
    elapsedMs: integer(source.elapsedMs, 0),
    startedAt: integer(source.startedAt, 0),
  };
}

/**
 * Elapsed time to feed the projection.
 * The stored counter is the floor. The caller's clock can be ahead of the
 * last write (the simulator advances, then reads status before dispatch
 * refreshes `elapsedMs`).
 *
 * @param {{elapsedMs: number, startedAt: number}} budget
 * @param {number} now
 * @returns {number}
 */
function projectedElapsedMs(budget, now) {
  if (!Number.isFinite(now)) return budget.elapsedMs;
  return Math.max(budget.elapsedMs, Math.max(0, Math.trunc(now) - budget.startedAt));
}

/**
 * One future model call per remaining step that actually runs a worker.
 * Approval does not chat. `done` already counted its call in `usedModelCalls`.
 * Summarize does chat, and the cap already reserves a slot for it, so a
 * summarize that is still queued counts as one. This is the next attempt,
 * not the three-attempt worst case: that worst case is what `maxModelCalls`
 * was sized for, and using it here would mark a legal eight-step plan over.
 *
 * @param {object[]} steps
 * @returns {number}
 */
function remainingModelCalls(steps) {
  let calls = 0;
  for (const step of steps) {
    if (!step || step.status === 'done') continue;
    if (step.workerType === 'approval') continue;
    calls += 1;
  }
  return calls;
}

/**
 * @param {Array<object>|null|undefined} steps
 * @param {object|null|undefined} budget
 * @param {number} now
 * @param {{stepsAlreadyCounted?: boolean}} [options]
 *   `true` when `usedSteps` already includes these rows (`get-run-status`).
 *   `false` when they are drafts `plan-split` has not stored yet.
 */
export function forecastBudget(steps, budget, now, options = {}) {
  const caps = capsOf(budget);
  const indexed = indexSteps(steps);
  const criticalPath = criticalPathOf(indexed, now);
  const elapsed = projectedElapsedMs(caps, now);
  const projectedWall = elapsed + criticalPath.durationMs;
  const pendingWork = countAddedWorkSteps(indexed.filter((step) => step.status !== 'done'));
  const projectedSteps = options.stepsAlreadyCounted === true
    ? caps.usedSteps
    : caps.usedSteps + pendingWork;
  const projectedCalls = caps.usedModelCalls + remainingModelCalls(indexed);
  /** @type {string[]} */
  const reasons = [];
  if (projectedWall > caps.wallClockMs) reasons.push(OVER_WALL);
  if (projectedSteps > caps.maxSteps) reasons.push(OVER_STEPS);
  if (projectedCalls > caps.maxModelCalls) reasons.push(OVER_CALLS);
  const clock = Number.isFinite(now) ? Math.trunc(now) : 0;
  return {
    criticalPath,
    eta: {
      remainingMs: criticalPath.durationMs,
      finishAt: clock + criticalPath.durationMs,
    },
    budgetOutlook: {
      over: reasons.length > 0,
      reasons,
    },
    projectedSteps,
    projectedCalls,
    projectedWall,
  };
}

/**
 * Clock for a status read.
 *
 * An explicit `overrides.now` wins. That is the simulator clock, and it is
 * also `startRun`'s clock. With no override, `Date.now()` is used when it
 * sits within one wall-clock cap of the budget clock (a live Forge invoke
 * of a run that was updated recently). A store pinned far away, which is
 * every unit test that freezes time at `1_700_000_000_000`, keeps the
 * budget clock so the projection does not treat the run as centuries old.
 *
 * @param {{now?: Function}|null|undefined} overrides
 * @param {{budget?: {startedAt?: number, elapsedMs?: number}, createdAt?: number}|null|undefined} run
 * @returns {number}
 */
export function resolveScheduleNow(overrides, run) {
  if (overrides && typeof overrides.now === 'function') {
    const value = overrides.now();
    if (Number.isFinite(value)) return Math.trunc(value);
  }
  const started = Number.isInteger(run?.budget?.startedAt)
    ? run.budget.startedAt
    : (Number.isFinite(run?.createdAt) ? Math.trunc(run.createdAt) : 0);
  const elapsed = Number.isInteger(run?.budget?.elapsedMs) && run.budget.elapsedMs > 0
    ? run.budget.elapsedMs
    : 0;
  const anchor = started + elapsed;
  const wall = Date.now();
  if (Math.abs(wall - anchor) <= RUN_WALL_CLOCK_MS) return wall;
  return anchor;
}

/**
 * Path, ETA, and outlook for steps the caller already loaded.
 * Read-only. Does not merge and does not touch KVS. `get-run-status` and
 * the panel loader both call this so a status read stays a status read.
 *
 * @param {Array<object>|null|undefined} steps
 * @param {object|null|undefined} budget
 * @param {number} now
 */
export function scheduleFor(steps, budget, now) {
  const forecast = forecastBudget(steps, budget, now, { stepsAlreadyCounted: true });
  return {
    criticalPath: forecast.criticalPath,
    eta: forecast.eta,
    budgetOutlook: forecast.budgetOutlook,
  };
}

/**
 * Put a specific duration where `createSteps` will keep it.
 * Top-level `durationMs` is not a step attribute. Leaving it on the draft
 * would drop it on the way into KVS. `input` is `any`, so the number lives
 * there. A string input becomes `{ text, durationMs }` only when the
 * planner actually set a duration. Plans that omit it stay strings, and
 * the workers keep seeing the same input they see today.
 *
 * @param {object} step
 * @returns {object}
 */
export function attachStepDuration(step) {
  const durationMs = readCustomDurationMs(step);
  if (durationMs == null || !step || typeof step !== 'object') return step;
  const input = step.input;
  let nextInput;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    nextInput = input.durationMs === durationMs ? input : { ...input, durationMs };
  } else if (typeof input === 'string' && input.length > 0) {
    nextInput = { text: input, durationMs };
  } else if (input === undefined || input === null || input === '') {
    nextInput = { durationMs };
  } else {
    nextInput = { value: input, durationMs };
  }
  const copy = { ...step, input: nextInput };
  delete copy.durationMs;
  return copy;
}

/**
 * True when `ancestorIdx` is `stepIdx` or a transitive dependency of it.
 *
 * @param {number} ancestorIdx
 * @param {number} stepIdx
 * @param {Map<number, object>} byIdx
 * @param {Set<number>} [seen]
 * @returns {boolean}
 */
function isAncestor(ancestorIdx, stepIdx, byIdx, seen = new Set()) {
  if (ancestorIdx === stepIdx) return true;
  if (seen.has(stepIdx)) return false;
  seen.add(stepIdx);
  const step = byIdx.get(stepIdx);
  if (!step) return false;
  return step.dependsOn.some((dep) => isAncestor(ancestorIdx, dep, byIdx, seen));
}

/**
 * @param {object} upstream
 * @param {object} downstream
 * @returns {object}
 */
function mergedInput(upstream, downstream) {
  const durationMs = Math.max(plannedDurationMs(upstream), plannedDurationMs(downstream));
  return {
    merged: true,
    durationMs,
    parts: [
      {
        title: typeof upstream.title === 'string' ? upstream.title : '',
        workerType: upstream.workerType,
        input: upstream.input,
      },
      {
        title: typeof downstream.title === 'string' ? downstream.title : '',
        workerType: downstream.workerType,
        input: downstream.input,
      },
    ],
  };
}

/**
 * Replace the downstream step with nothing and fold it into the upstream
 * step. Dependents of either index now point at the survivor. Indexes are
 * rewritten to `0..n-1` in the original order, which is the order
 * `createSteps` will store on a new run.
 *
 * The merged duration is the longer of the two, not the sum. Joining is
 * how the path gets shorter. Summing would keep the same ETA and the
 * budget would never fit.
 *
 * @param {object[]} steps
 * @param {{upstream: number, downstream: number}} pair
 * @returns {object[]}
 */
function applyMerge(steps, pair) {
  const upstream = steps.find((step) => step.idx === pair.upstream);
  const downstream = steps.find((step) => step.idx === pair.downstream);
  if (!upstream || !downstream) return steps.map((step) => ({ ...step, dependsOn: [...step.dependsOn] }));
  const survivor = upstream.idx;
  const removed = downstream.idx;
  const merged = {
    ...upstream,
    title: `${upstream.title} + ${downstream.title}`,
    workerType: upstream.workerType,
    input: mergedInput(upstream, downstream),
    dependsOn: dedupe(
      [...upstream.dependsOn, ...downstream.dependsOn]
        .filter((idx) => idx !== survivor && idx !== removed),
    ),
    idx: survivor,
  };
  delete merged.durationMs;
  delete merged.stepId;
  delete merged.status;

  /** @type {object[]} */
  const kept = [];
  for (const step of steps) {
    if (step.idx === removed) continue;
    if (step.idx === survivor) {
      kept.push(merged);
      continue;
    }
    kept.push({
      ...step,
      dependsOn: dedupe(
        step.dependsOn.map((idx) => (idx === survivor || idx === removed ? survivor : idx)),
      ).filter((idx) => idx !== step.idx),
    });
  }

  /** @type {Map<number, number>} */
  const oldToNew = new Map();
  kept.forEach((step, index) => oldToNew.set(step.idx, index));
  return kept.map((step, index) => ({
    ...step,
    idx: index,
    dependsOn: dedupe(
      step.dependsOn
        .map((idx) => oldToNew.get(idx))
        .filter((idx) => Number.isInteger(idx)),
    ),
  }));
}

/**
 * Pairs that are legal to join, best candidate not yet chosen.
 * Adjacent means a direct `dependsOn` edge (any worker type). A pair with
 * no edge is included only when both sides share a worker type and neither
 * is upstream of the other, so the join cannot invent a cycle.
 *
 * @param {object[]} steps
 * @returns {Array<{upstream: number, downstream: number, sameType: boolean, adjacent: boolean}>}
 */
function candidatePairs(steps) {
  const byIdx = new Map(steps.map((step) => [step.idx, step]));
  /** @type {Array<{upstream: number, downstream: number, sameType: boolean, adjacent: boolean}>} */
  const pairs = [];
  const seen = new Set();

  /**
   * @param {object} upstream
   * @param {object} downstream
   * @param {boolean} adjacent
   */
  function add(upstream, downstream, adjacent) {
    if (!isMergeable(upstream) || !isMergeable(downstream)) return;
    if (upstream.idx === downstream.idx) return;
    const key = `${upstream.idx}->${downstream.idx}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({
      upstream: upstream.idx,
      downstream: downstream.idx,
      sameType: upstream.workerType === downstream.workerType,
      adjacent,
    });
  }

  for (const step of steps) {
    if (!isMergeable(step)) continue;
    for (const dep of step.dependsOn) {
      const upstream = byIdx.get(dep);
      if (!upstream) continue;
      add(upstream, step, true);
    }
  }

  const cheap = steps.filter((step) => isMergeable(step));
  for (let left = 0; left < cheap.length; left += 1) {
    for (let right = left + 1; right < cheap.length; right += 1) {
      const a = cheap[left];
      const b = cheap[right];
      if (a.workerType !== b.workerType) continue;
      if (isAncestor(a.idx, b.idx, byIdx) || isAncestor(b.idx, a.idx, byIdx)) continue;
      // Survivor is the lower index, matching applyMerge's upstream slot.
      if (a.idx < b.idx) add(a, b, false);
      else add(b, a, false);
    }
  }
  return pairs;
}

/**
 * Higher duration drop first, then fewer future model calls, then the
 * same worker type, then a real edge, then the lowest indexes.
 *
 * @param {{durationDrop: number, callsDrop: number, sameType: boolean, adjacent: boolean, upstream: number, downstream: number}} left
 * @param {{durationDrop: number, callsDrop: number, sameType: boolean, adjacent: boolean, upstream: number, downstream: number}} right
 * @returns {number}
 */
function compareRank(left, right) {
  if (left.durationDrop !== right.durationDrop) return right.durationDrop - left.durationDrop;
  if (left.callsDrop !== right.callsDrop) return right.callsDrop - left.callsDrop;
  if (left.sameType !== right.sameType) return (right.sameType ? 1 : 0) - (left.sameType ? 1 : 0);
  if (left.adjacent !== right.adjacent) return (right.adjacent ? 1 : 0) - (left.adjacent ? 1 : 0);
  if (left.upstream !== right.upstream) return left.upstream - right.upstream;
  return left.downstream - right.downstream;
}

/**
 * Join one pair when the forecast is over.
 * The returned `steps` are a new array. The input array is not modified.
 * `mergedIdxs` names the original indexes, upstream then downstream,
 * before the list is reindexed.
 *
 * Safe to call again: a plan that fits returns `within-budget` and the
 * same steps. A plan that is over but has nothing useful to join returns
 * the original steps and a reason, and does not invent a step.
 *
 * @param {Array<object>|null|undefined} steps
 * @param {object|null|undefined} budget
 * @param {number} now
 * @returns {{
 *   steps: object[],
 *   applied: boolean,
 *   reason: string,
 *   mergedIdxs: number[],
 *   criticalPath: {indexes: number[], keys: string[], durationMs: number},
 *   eta: {remainingMs: number, finishAt: number},
 *   budgetOutlook: {over: boolean, reasons: string[]},
 * }}
 */
export function applyBudgetReplan(steps, budget, now) {
  const indexed = indexSteps(steps);
  const before = forecastBudget(indexed, budget, now, { stepsAlreadyCounted: false });
  if (!before.budgetOutlook.over) {
    return {
      steps: indexed,
      applied: false,
      reason: REPLAN_WITHIN_BUDGET,
      mergedIdxs: [],
      criticalPath: before.criticalPath,
      eta: before.eta,
      budgetOutlook: before.budgetOutlook,
    };
  }

  /** @type {Array<{pair: {upstream: number, downstream: number, sameType: boolean, adjacent: boolean}, steps: object[], forecast: ReturnType<typeof forecastBudget>, rank: object}>} */
  const helpful = [];
  for (const pair of candidatePairs(indexed)) {
    const mergedSteps = applyMerge(indexed, pair);
    const after = forecastBudget(mergedSteps, budget, now, { stepsAlreadyCounted: false });
    const durationDrop = before.criticalPath.durationMs - after.criticalPath.durationMs;
    const callsDrop = before.projectedCalls - after.projectedCalls;
    const stepsDrop = before.projectedSteps - after.projectedSteps;
    const reasons = before.budgetOutlook.reasons;
    const helpsWall = reasons.includes(OVER_WALL) && durationDrop > 0;
    const helpsSteps = reasons.includes(OVER_STEPS) && stepsDrop > 0;
    const helpsCalls = reasons.includes(OVER_CALLS) && callsDrop > 0;
    if (!helpsWall && !helpsSteps && !helpsCalls) continue;
    helpful.push({
      pair,
      steps: mergedSteps,
      forecast: after,
      rank: {
        durationDrop,
        callsDrop,
        sameType: pair.sameType,
        adjacent: pair.adjacent,
        upstream: pair.upstream,
        downstream: pair.downstream,
      },
    });
  }

  if (helpful.length === 0) {
    const reason = candidatePairs(indexed).length === 0 ? REPLAN_NO_PAIR : REPLAN_NO_HELP;
    return {
      steps: indexed,
      applied: false,
      reason,
      mergedIdxs: [],
      criticalPath: before.criticalPath,
      eta: before.eta,
      budgetOutlook: before.budgetOutlook,
    };
  }

  helpful.sort((left, right) => compareRank(left.rank, right.rank));
  const chosen = helpful[0];
  return {
    steps: chosen.steps,
    applied: true,
    reason: chosen.forecast.budgetOutlook.over ? REPLAN_MERGED_STILL_OVER : REPLAN_MERGED,
    mergedIdxs: [chosen.pair.upstream, chosen.pair.downstream],
    criticalPath: chosen.forecast.criticalPath,
    eta: chosen.forecast.eta,
    budgetOutlook: chosen.forecast.budgetOutlook,
  };
}
