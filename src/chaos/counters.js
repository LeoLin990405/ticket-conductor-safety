/**
 * Chaos counters on the run the panel already reads (novelty #7).
 *
 * The three numbers live on `run.budget.chaos`, the existing `any`
 * attribute. There is no new entity, scope, queue, or step status.
 * Forge stores the whole budget as one value, so a counter move rewrites
 * that value. The rewrite happens only when the fault gate is open and a
 * counter actually changes. Production and staging leave the attribute
 * exactly as the budget writer last stored it.
 *
 * What each number means
 * ----------------------
 * - `injected` — a fault fired. A kill stopped the worker, a duplicate
 *   queue message was pushed, or the applier returned an injected 429.
 *   Arming a fault that never fires does not count. `injectFault` has no
 *   run id; the run is known only when the hook runs.
 * - `healed` — the matching recovery. The watchdog retried a killed step,
 *   the applier dropped a duplicate request key that was already applied,
 *   or the effect retry applied after the injected 429.
 * - `duplicateWrites` — a Jira mutation completed twice for one request
 *   key. The duplicate-effect path is supposed to leave this at 0. The
 *   applier still skips a row that is already `applied`. This counter
 *   moves only if a second mutation gets through anyway.
 *
 * The "which fault is still open" marks live in `faults.js`, in this
 * process. A cold start forgets them. The numbers on the run do not.
 *
 * The write uses a `chaos:<runId>` lock, not the `run:<runId>` lock.
 * `startRun` already holds the run lock when it enqueues the child issue,
 * and that enqueue is where a duplicate fault fires. Taking the run lock
 * again would wait on itself.
 *
 * @module chaos/counters
 */

import { noteEffectDeduped, takePendingEffectDeduped } from '../effects/metrics.js';
import { withLock } from '../run/locks.js';
import { applyRunBudget, readChaosCounters, readStoredEffectDeduped } from '../run/budget.js';
import {
  claimDuplicateHeal,
  claimKillHeal,
  claimRateLimitHeal,
  isFaultInjectionEnabled,
  rememberDuplicate,
  rememberJiraWrite,
  rememberKill,
  rememberRateLimit,
} from './faults.js';

/**
 * Run a counter update without letting it change the caller's outcome.
 * A lost counter must not fail a kill, retry an effect, or undo a
 * watchdog retry. The caller still awaits it so the number is stored
 * before the handler returns.
 *
 * @param {{warn?: Function, error?: Function}|null|undefined} logger
 * @param {() => Promise<unknown>} task
 * @returns {Promise<unknown>}
 */
export async function safeChaos(logger, task) {
  try {
    return await task();
  } catch (error) {
    const warn = logger && typeof logger.warn === 'function' ? logger.warn : null;
    if (warn) {
      warn.call(logger, 'Chaos counter was not stored', error);
    }
    return null;
  }
}

/**
 * Add one to a counter and store the budget. No-op when the gate is closed,
 * so this function does not read KVS on the production path.
 *
 * @param {{getRun: Function, updateRun: Function}} store
 * @param {string} runId
 * @param {'injected'|'healed'|'duplicateWrites'} field
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<import('../store/types.js').Run|null>}
 */
export async function bumpChaosCounter(store, runId, field, env) {
  if (!isFaultInjectionEnabled(env)) return null;
  if (field !== 'injected' && field !== 'healed' && field !== 'duplicateWrites') return null;
  if (typeof runId !== 'string' || runId.length === 0) return null;
  if (!store || typeof store.getRun !== 'function' || typeof store.updateRun !== 'function') {
    return null;
  }
  // Serialise two counters for one run inside this process. Do not take
  // `run:<runId>`: the caller may already hold it.
  return withLock(`chaos:${runId}`, async () => {
    const run = await store.getRun(runId);
    if (!run) return null;
    // Take the dedupe tally only once we know the run exists. A failed
    // write puts it back, so a lost chaos update does not lose the count.
    const pending = takePendingEffectDeduped(runId);
    try {
      const chaos = readChaosCounters(run.budget);
      chaos[field] += 1;
      // Keep the caps and the usage counters. `now` is omitted on purpose:
      // this write must not move `elapsedMs`. The simulator clock is not
      // available in every hook, and a wall clock here would jump the budget.
      const budget = applyRunBudget(run.budget, { startedAt: run.createdAt });
      budget.chaos = {
        injected: chaos.injected,
        healed: chaos.healed,
        duplicateWrites: chaos.duplicateWrites,
      };
      // Same write as the chaos counter. A run with no dropped duplicate
      // leaves `effects` off the object, so the stored bytes stay the same.
      const deduped = readStoredEffectDeduped(run.budget) + pending;
      if (deduped > 0) {
        budget.effects = { deduped };
      }
      return await store.updateRun(runId, { budget });
    } catch (error) {
      if (pending > 0) noteEffectDeduped(runId, pending);
      throw error;
    }
  });
}

/**
 * Count one fired fault and remember what would heal it.
 *
 * @param {{getRun: Function, updateRun: Function}} store
 * @param {{runId?: string, stepId?: string, requestKey?: string, kind?: string}} marker
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<import('../store/types.js').Run|null>}
 */
export async function recordFaultInjected(store, marker, env) {
  if (!isFaultInjectionEnabled(env)) return null;
  const runId = marker && typeof marker.runId === 'string' ? marker.runId : '';
  const kind = marker && marker.kind;
  let remembered = false;
  if (kind === 'kill-worker') {
    remembered = rememberKill(marker.stepId, runId, env);
  } else if (kind === 'duplicate-effect') {
    remembered = rememberDuplicate(marker.requestKey, runId, env);
  } else if (kind === 'jira-429') {
    remembered = rememberRateLimit(marker.requestKey, runId, env);
  }
  if (!remembered) return null;
  return bumpChaosCounter(store, runId, 'injected', env);
}

/**
 * The watchdog retried a step that a kill had left `running`.
 * A normal stuck step is not in the kill map, so this is a no-op and it
 * does not read the run.
 *
 * @param {{getRun: Function, updateRun: Function}} store
 * @param {{stepId?: string}|null|undefined} step
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<import('../store/types.js').Run|null>}
 */
export async function recordKillHealed(store, step, env) {
  const runId = claimKillHeal(step && step.stepId, env);
  if (!runId) return null;
  return bumpChaosCounter(store, runId, 'healed', env);
}

/**
 * The applier saw an already-applied request key and did not call Jira.
 * Only a key that was pushed by a duplicate fault counts. An ordinary
 * at-least-once redelivery is not a heal.
 *
 * @param {{getRun: Function, updateRun: Function}} store
 * @param {{requestKey?: string}|null|undefined} effect
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<import('../store/types.js').Run|null>}
 */
export async function recordDuplicateHealed(store, effect, env) {
  const runId = claimDuplicateHeal(effect && effect.requestKey, env);
  if (!runId) return null;
  return bumpChaosCounter(store, runId, 'healed', env);
}

/**
 * The retry after an injected 429 applied the effect.
 *
 * @param {{getRun: Function, updateRun: Function}} store
 * @param {{requestKey?: string}|null|undefined} effect
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<import('../store/types.js').Run|null>}
 */
async function recordRateLimitHealed(store, effect, env) {
  const runId = claimRateLimitHeal(effect && effect.requestKey, env);
  if (!runId) return null;
  return bumpChaosCounter(store, runId, 'healed', env);
}

/**
 * One Jira mutation just finished for this request key.
 *
 * The first success only remembers the key. A second success increments
 * `duplicateWrites`. If this success is the retry after an injected 429,
 * it also increments `healed`. A closed gate returns before either check.
 *
 * @param {{getRun: Function, updateRun: Function}} store
 * @param {{requestKey?: string, runId?: string}|null|undefined} effect
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<import('../store/types.js').Run|null>}
 */
export async function recordJiraWrite(store, effect, env) {
  if (!isFaultInjectionEnabled(env)) return null;
  const requestKey = effect && effect.requestKey;
  if (typeof requestKey !== 'string' || requestKey.length === 0) return null;
  const again = rememberJiraWrite(requestKey, env);
  const healed = await recordRateLimitHealed(store, effect, env);
  if (!again) return healed;
  const runId = effect && typeof effect.runId === 'string' && effect.runId.length > 0
    ? effect.runId
    : null;
  if (!runId) return healed;
  return bumpChaosCounter(store, runId, 'duplicateWrites', env);
}
