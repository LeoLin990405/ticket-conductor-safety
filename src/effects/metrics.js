/**
 * Effect throughput counters for one run (applied, deduped, retried).
 *
 * `applied` and `retried` are derived from the effect rows the caller
 * already holds (`status` and `tries`). Deriving them does not write KVS.
 * A cold Forge invocation, including the Run panel, sees the same numbers
 * the applier stored on those rows.
 *
 * `deduped` is not on the row. Dropping a duplicate delivery is supposed
 * to write nothing: the redelivery scenario checks that the KVS write
 * counter stays at 0. The count therefore lives in this process until a
 * run-budget write that is already happening can carry it. The chaos heal
 * is that write. `bumpChaosCounter` folds the pending tally into
 * `run.budget.effects.deduped` and clears the process map. A closed fault
 * gate never does that write, so an ordinary at-least-once redelivery
 * stays at 0 KVS write bytes and the tally is visible only in the process
 * that dropped the message.
 *
 * There is no new entity, attribute, scope, or queue. `budget` is already
 * `any`. The `effects` object is omitted until a dedupe has been flushed.
 *
 * @module effects/metrics
 */

import { readStoredEffectDeduped } from '../run/budget.js';

/**
 * Drops this process has not flushed onto a run yet.
 * Keyed by run id. Cleared by `resetEffectMetrics` between scenarios.
 *
 * @type {Map<string, number>}
 */
const pendingDeduped = new Map();

/**
 * @param {unknown} runId
 * @returns {string}
 */
function runKey(runId) {
  return typeof runId === 'string' ? runId : '';
}

/**
 * Remember one dropped duplicate for this run.
 * A missing run id is ignored: there is nowhere to show the number.
 *
 * @param {unknown} runId
 * @param {number} [count] How many drops to add. Defaults to 1.
 * @returns {void}
 */
export function noteEffectDeduped(runId, count = 1) {
  const key = runKey(runId);
  if (key.length === 0) return;
  if (!Number.isInteger(count) || count <= 0) return;
  pendingDeduped.set(key, (pendingDeduped.get(key) ?? 0) + count);
}

/**
 * Drops still waiting in this process. Does not clear them.
 *
 * @param {unknown} runId
 * @returns {number}
 */
export function pendingEffectDeduped(runId) {
  const key = runKey(runId);
  if (key.length === 0) return 0;
  return pendingDeduped.get(key) ?? 0;
}

/**
 * Take the pending drops so a budget write can store them.
 * The caller must put the number back with `noteEffectDeduped` if that
 * write does not happen, or the count is gone for this process.
 *
 * @param {unknown} runId
 * @returns {number}
 */
export function takePendingEffectDeduped(runId) {
  const key = runKey(runId);
  if (key.length === 0) return 0;
  const value = pendingDeduped.get(key) ?? 0;
  pendingDeduped.delete(key);
  return value;
}

/**
 * True when a scenario left a dedupe tally behind.
 * The simulator treats that the same way as a leftover effect clock.
 *
 * @returns {boolean}
 */
export function hasPendingEffectMetrics() {
  return pendingDeduped.size > 0;
}

/**
 * Drop every in-process tally. Called when effect dependencies reset.
 *
 * @returns {void}
 */
export function resetEffectMetrics() {
  pendingDeduped.clear();
}

/**
 * Counters derived from effect rows. `deduped` is always 0 here.
 * The caller adds the stored tally and the in-process tally.
 *
 * A row in `retrying` has scheduled one retry per failed try, so
 * `retried` is `tries`. A row that reached `applied` or `failed` spent
 * its last try on that outcome, so the retries are `tries - 1`.
 * Waiting for a child issue key does not increment `tries` and is not a
 * retry.
 *
 * @param {Array<{status?: string, tries?: number}>|null|undefined} effects
 * @returns {{applied: number, deduped: number, retried: number}}
 */
export function effectMetricsFromEffects(effects) {
  let applied = 0;
  let retried = 0;
  const rows = Array.isArray(effects) ? effects : [];
  for (const effect of rows) {
    if (!effect || typeof effect !== 'object') continue;
    const tries = Number.isInteger(effect.tries) && effect.tries > 0 ? effect.tries : 0;
    if (effect.status === 'applied') applied += 1;
    if (effect.status === 'retrying') {
      retried += tries;
    } else if (effect.status === 'applied' || effect.status === 'failed') {
      retried += Math.max(0, tries - 1);
    }
  }
  return { applied, deduped: 0, retried };
}

/**
 * The three numbers `get-run-status` and the panel return.
 * `applied` and `retried` come from the rows. `deduped` is whatever a
 * previous budget write stored, plus drops this process has not flushed.
 *
 * @param {Array<{status?: string, tries?: number}>|null|undefined} effects
 * @param {unknown} budget Stored `run.budget`, not the read model.
 * @param {unknown} runId
 * @returns {{applied: number, deduped: number, retried: number}}
 */
export function combineEffectMetrics(effects, budget, runId) {
  const metrics = effectMetricsFromEffects(effects);
  metrics.deduped = readStoredEffectDeduped(budget) + pendingEffectDeduped(runId);
  return metrics;
}
