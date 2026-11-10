/**
 * Run budget for novelty #6 (cost and latency), first slice.
 *
 * Each run stores one object on the `run` entity, attribute `budget`, type
 * `any`. Forge has no array or object attribute type, so the caps and the
 * measured counters share one value. The entity key stays `runId`. Do not
 * add `runId` inside this object, and do not remove the attribute once it
 * has been deployed: Forge rejects an undeclared attribute with a bare 422,
 * and it also rejects deleting an attribute that already shipped.
 *
 * What this slice stores
 * -----------------------
 * Caps the panel can show later, plus the usage the simulator (and, in
 * December, a real run) measured:
 *
 * - `maxSteps` — work steps, the same 8 `plan-split` already enforces.
 *   The automatic `summarize` step is not a work step and does not count.
 * - `maxModelCalls` — one chat per work step per attempt (the watchdog
 *   allows three attempts), plus one chat per lead wave, plus the
 *   summarize step. A disabled or missing model is not a call, so
 *   `CONDUCTOR_LLM=off` leaves the counter at 0 and does not write.
 * - `wallClockMs` — `maxSteps` times the 12 minute step deadline. That is
 *   the longest a fully serial plan can sit on the clock this app already
 *   uses. It is not an ETA.
 * - `usedSteps`, `usedModelCalls`, `usedTokens`, `elapsedMs`, `startedAt`.
 *
 * `usedTokens` is the sum of `usage.total_tokens`, or `input_tokens` plus
 * `output_tokens`, from chats that actually ran. There is no separate token
 * cap yet: the per-call `max_completion_tokens` already lives on each
 * `completeText` request. This module only records. Going over a cap does
 * not change `run.status`. The critical path, the ETA, and the one-pair
 * merge live in `criticalPath.js` and run from `plan-split` before the
 * steps are stored. They are not written onto this object.
 *
 * Chaos counters (novelty #7) share this same `any` value so the panel
 * does not need a new attribute. `chaos` is `{injected, healed,
 * duplicateWrites}`. It is absent until a fault actually fires, and the
 * fault gate is the only writer. A normal run, including production and
 * staging, keeps the eight fields above and the row stays the same size.
 * `readRunBudget` still returns zeros so status can render before the
 * first fault. A later budget write (step count, model calls, elapsed)
 * copies `chaos` through. Dropping it here would erase the proof the
 * panel is showing.
 *
 * The step brief's `budget` (tool calls, output bytes, one repair) is a
 * different object on the step. Do not mix the two.
 *
 * @module run/budget
 */

import { MAX_STEPS, MAX_WAVES } from './digest.js';

/**
 * How long one step may run before the watchdog retries it.
 * Same duration as `STEP_DEADLINE_MS` in `dependencies.js`. Kept as a
 * literal here so this module does not import the dependency resolver
 * (that file imports the store, and the store imports this module).
 *
 * @constant {number}
 */
const STEP_DEADLINE_MS = 12 * 60 * 1000;

/** Work-step cap. Summarize is extra and is not counted. @constant {number} */
export const RUN_MAX_STEPS = MAX_STEPS;

/**
 * Model-call cap.
 * 8 work steps × 3 attempts, plus one lead chat per wave (3), plus summarize.
 * @constant {number}
 */
export const RUN_MAX_MODEL_CALLS = MAX_STEPS * 3 + MAX_WAVES + 1;

/**
 * Wall-clock cap: every work step may use its full deadline, one after another.
 * Not a predicted ETA. The panel reads this number; it does not compute a path.
 * @constant {number}
 */
export const RUN_WALL_CLOCK_MS = MAX_STEPS * STEP_DEADLINE_MS;

/**
 * Worker type that closes a run. It is not one of the 8 planned steps.
 * @constant {string}
 */
const SUMMARIZE_WORKER = 'summarize';

/**
 * @param {number} now Epoch ms from the caller's clock. The simulator's
 *   fake clock is the source of `startedAt` and `elapsedMs`.
 * @returns {RunBudget}
 */
export function initialRunBudget(now) {
  const startedAt = Number.isFinite(now) ? Math.trunc(now) : 0;
  return {
    maxSteps: RUN_MAX_STEPS,
    maxModelCalls: RUN_MAX_MODEL_CALLS,
    wallClockMs: RUN_WALL_CLOCK_MS,
    usedSteps: 0,
    usedModelCalls: 0,
    usedTokens: 0,
    elapsedMs: 0,
    startedAt,
  };
}

/** Counter names stored on `budget.chaos`. The panel and get-run-status share this list. */
export const CHAOS_COUNTER_FIELDS = Object.freeze([
  'injected',
  'healed',
  'duplicateWrites',
]);

/**
 * Zeros for a run that has not fired a fault. This object is for readers.
 * Do not write it back onto the row: that would grow every run.
 *
 * @returns {{injected: number, healed: number, duplicateWrites: number}}
 */
export function emptyChaosCounters() {
  return {
    injected: 0,
    healed: 0,
    duplicateWrites: 0,
  };
}

/**
 * Read the three counters. A missing or damaged `chaos` object becomes
 * zeros. The stored row is not changed.
 *
 * @param {unknown} budget
 * @returns {{injected: number, healed: number, duplicateWrites: number}}
 */
export function readChaosCounters(budget) {
  const counters = emptyChaosCounters();
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) return counters;
  const chaos = /** @type {Record<string, unknown>} */ (budget).chaos;
  if (!chaos || typeof chaos !== 'object' || Array.isArray(chaos)) return counters;
  const record = /** @type {Record<string, unknown>} */ (chaos);
  for (const field of CHAOS_COUNTER_FIELDS) {
    const value = record[field];
    if (Number.isInteger(value) && /** @type {number} */ (value) >= 0) {
      counters[field] = /** @type {number} */ (value);
    }
  }
  return counters;
}

/**
 * A stored `chaos` object worth keeping on the next budget write.
 * Invalid shapes are dropped rather than copied forward. The store
 * rejects those shapes on the way in, so this is the belt for a writer
 * that built the object by hand.
 *
 * @param {unknown} budget
 * @returns {{injected: number, healed: number, duplicateWrites: number}|null}
 */
function copyStoredChaos(budget) {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) return null;
  const chaos = /** @type {Record<string, unknown>} */ (budget).chaos;
  if (!chaos || typeof chaos !== 'object' || Array.isArray(chaos)) return null;
  const record = /** @type {Record<string, unknown>} */ (chaos);
  /** @type {Record<string, number>} */
  const copied = {};
  for (const field of CHAOS_COUNTER_FIELDS) {
    const value = record[field];
    if (!Number.isInteger(value) || /** @type {number} */ (value) < 0) return null;
    copied[field] = /** @type {number} */ (value);
  }
  return {
    injected: copied.injected,
    healed: copied.healed,
    duplicateWrites: copied.duplicateWrites,
  };
}

/**
 * The dedupe tally a chaos (or other budget) write already flushed.
 * Absent, or any shape that is not `{deduped: <integer>}`, reads as 0.
 * Readers must not write the 0 back: that would grow every run.
 *
 * @param {unknown} budget
 * @returns {number}
 */
export function readStoredEffectDeduped(budget) {
  const copied = copyStoredEffectDeduped(budget);
  return copied ? copied.deduped : 0;
}

/**
 * A stored `effects` object worth keeping on the next budget write.
 * Invalid shapes are dropped. The only field is `deduped`. `applied` and
 * `retried` are derived from effect rows and are not stored here.
 *
 * @param {unknown} budget
 * @returns {{deduped: number}|null}
 */
function copyStoredEffectDeduped(budget) {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget)) return null;
  const effects = /** @type {Record<string, unknown>} */ (budget).effects;
  if (effects === undefined) return null;
  if (!effects || typeof effects !== 'object' || Array.isArray(effects)) return null;
  const record = /** @type {Record<string, unknown>} */ (effects);
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'deduped') return null;
  const deduped = record.deduped;
  if (!Number.isInteger(deduped) || /** @type {number} */ (deduped) < 0) return null;
  return { deduped: /** @type {number} */ (deduped) };
}

/**
 * @param {unknown} value
 * @returns {value is RunBudget}
 */
function isRunBudget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const budget = /** @type {Record<string, unknown>} */ (value);
  return [
    'maxSteps',
    'maxModelCalls',
    'wallClockMs',
    'usedSteps',
    'usedModelCalls',
    'usedTokens',
    'elapsedMs',
    'startedAt',
  ].every((field) => Number.isInteger(budget[field]) && /** @type {number} */ (budget[field]) >= 0);
}

/**
 * The object `get-run-status` and the panel should read.
 * Missing or damaged storage becomes a zero-usage budget so an old row
 * still renders. Caps always come from the constants above, not from
 * whatever an older deploy wrote.
 *
 * @param {unknown} budget
 * @param {number} [startedAt] Fallback when the stored object has no clock.
 * @returns {RunBudget}
 */
export function readRunBudget(budget, startedAt) {
  if (!isRunBudget(budget)) {
    return {
      ...initialRunBudget(Number.isFinite(startedAt) ? /** @type {number} */ (startedAt) : 0),
      chaos: emptyChaosCounters(),
    };
  }
  return {
    maxSteps: RUN_MAX_STEPS,
    maxModelCalls: RUN_MAX_MODEL_CALLS,
    wallClockMs: RUN_WALL_CLOCK_MS,
    usedSteps: budget.usedSteps,
    usedModelCalls: budget.usedModelCalls,
    usedTokens: budget.usedTokens,
    elapsedMs: budget.elapsedMs,
    startedAt: budget.startedAt,
    // Always present on the read model. Zeros when the row has no `chaos`
    // key, which is every run that has not fired a fault.
    chaos: readChaosCounters(budget),
  };
}

/**
 * @param {unknown} usage Provider usage object. Forge LLM uses the OpenAI
 *   field names (`input_tokens`, `output_tokens`, sometimes `total_tokens`).
 * @returns {number}
 */
export function tokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return 0;
  const record = /** @type {Record<string, unknown>} */ (usage);
  if (Number.isInteger(record.total_tokens) && /** @type {number} */ (record.total_tokens) >= 0) {
    return /** @type {number} */ (record.total_tokens);
  }
  const input = Number.isInteger(record.input_tokens) && /** @type {number} */ (record.input_tokens) >= 0
    ? /** @type {number} */ (record.input_tokens)
    : 0;
  const output = Number.isInteger(record.output_tokens) && /** @type {number} */ (record.output_tokens) >= 0
    ? /** @type {number} */ (record.output_tokens)
    : 0;
  return input + output;
}

/**
 * Add one chat to an in-memory meter. The worker flushes the meter once,
 * under the run lock, so parallel steps do not lose each other's counts.
 *
 * `disabled` and `unavailable` are not calls: the model was never asked.
 * `empty` and `error` are calls: `chat` ran and failed.
 *
 * @param {{calls?: number, tokens?: number}|null|undefined} meter
 * @param {{ok?: boolean, reason?: string, usage?: object|null}|null|undefined} result
 * @returns {void}
 */
export function noteModelResult(meter, result) {
  if (!meter || typeof meter !== 'object' || Array.isArray(meter)) return;
  if (!result || result.reason === 'disabled' || result.reason === 'unavailable') return;
  if (result.ok !== true && result.reason !== 'empty' && result.reason !== 'error') return;
  meter.calls = (Number.isInteger(meter.calls) ? meter.calls : 0) + 1;
  meter.tokens = (Number.isInteger(meter.tokens) ? meter.tokens : 0) + tokensFromUsage(result.usage);
}

/**
 * @param {unknown} budget Stored budget, or anything an old row might have.
 * @param {{steps?: number, calls?: number, tokens?: number, now?: number, startedAt?: number}} [delta]
 * @returns {RunBudget}
 */
export function applyRunBudget(budget, delta = {}) {
  const current = isRunBudget(budget) ? budget : null;
  const startedAt = current
    ? current.startedAt
    : (Number.isFinite(delta.startedAt) ? Math.trunc(/** @type {number} */ (delta.startedAt)) : 0);
  const now = Number.isFinite(delta.now) ? Math.trunc(/** @type {number} */ (delta.now)) : startedAt;
  const elapsed = Math.max(current ? current.elapsedMs : 0, Math.max(0, now - startedAt));
  const steps = Number.isInteger(delta.steps) && delta.steps > 0 ? delta.steps : 0;
  const calls = Number.isInteger(delta.calls) && delta.calls > 0 ? delta.calls : 0;
  const tokens = Number.isInteger(delta.tokens) && delta.tokens > 0 ? delta.tokens : 0;
  // Same key order as before. `chaos` is appended only when the row
  // already has it, so a run that never fired a fault serialises to the
  // same bytes. `effects` follows `chaos` and is omitted until a dedupe
  // tally has been flushed onto an existing budget write.
  /** @type {RunBudget} */
  const next = {
    maxSteps: RUN_MAX_STEPS,
    maxModelCalls: RUN_MAX_MODEL_CALLS,
    wallClockMs: RUN_WALL_CLOCK_MS,
    usedSteps: (current ? current.usedSteps : 0) + steps,
    usedModelCalls: (current ? current.usedModelCalls : 0) + calls,
    usedTokens: (current ? current.usedTokens : 0) + tokens,
    elapsedMs: elapsed,
    startedAt,
  };
  const chaos = copyStoredChaos(budget);
  if (chaos) next.chaos = chaos;
  const effectDeduped = copyStoredEffectDeduped(budget);
  if (effectDeduped) next.effects = effectDeduped;
  return next;
}

/**
 * True when every measured counter is still inside its cap.
 * A false result does not block the run and does not merge steps.
 * The merge (`criticalPath.js`) looks at the projected path as well as
 * these counters, and only while the plan is still a draft.
 *
 * @param {RunBudget} budget
 * @returns {boolean}
 */
export function isWithinRunBudget(budget) {
  return budget.usedSteps <= budget.maxSteps
    && budget.usedModelCalls <= budget.maxModelCalls
    && budget.elapsedMs <= budget.wallClockMs;
}

/**
 * How many of these new rows count against `maxSteps`.
 * `summarize` is the closer the state machine appends. An approval gate
 * is a real step and does count.
 *
 * @param {Array<{workerType?: string}|null|undefined>} steps
 * @returns {number}
 */
export function countAddedWorkSteps(steps) {
  if (!Array.isArray(steps)) return 0;
  return steps.filter((step) => step && step.workerType !== SUMMARIZE_WORKER).length;
}

/**
 * Persist a model-call delta on the run. No-op when the meter is empty,
 * so the common `CONDUCTOR_LLM=off` path does not add a KVS write.
 *
 * Does not change `status`. Does not enqueue anything.
 *
 * @param {{getRun: Function, updateRun: Function}} store
 * @param {string} runId
 * @param {{calls?: number, tokens?: number}|null|undefined} delta
 * @param {number} now
 * @returns {Promise<import('../store/types.js').Run|null>}
 */
export async function commitRunBudget(store, runId, delta, now) {
  const calls = Number.isInteger(delta?.calls) && /** @type {number} */ (delta.calls) > 0
    ? /** @type {number} */ (delta.calls)
    : 0;
  const tokens = Number.isInteger(delta?.tokens) && /** @type {number} */ (delta.tokens) > 0
    ? /** @type {number} */ (delta.tokens)
    : 0;
  if (calls === 0 && tokens === 0) return null;
  const run = await store.getRun(runId);
  if (!run) return null;
  const budget = applyRunBudget(run.budget, {
    calls,
    tokens,
    now,
    startedAt: run.createdAt,
  });
  return store.updateRun(runId, { budget });
}

/**
 * @typedef {object} RunBudget
 * @property {number} maxSteps
 * @property {number} maxModelCalls
 * @property {number} wallClockMs
 * @property {number} usedSteps
 * @property {number} usedModelCalls
 * @property {number} usedTokens
 * @property {number} elapsedMs
 * @property {number} startedAt
 * @property {{injected: number, healed: number, duplicateWrites: number}} [chaos]
 *   Omitted on a stored budget until a fault counter moves. `readRunBudget`
 *   always fills it in for the caller.
 * @property {{deduped: number}} [effects]
 *   Omitted until a dedupe tally is flushed onto a budget write that was
 *   already going to happen. Not part of the public read model.
 */
