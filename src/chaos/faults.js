/**
 * Simulator and development fault injection (novelty #7, chaos mode).
 *
 * Three faults, each consumed once:
 * - `kill-worker` stops a step after it has started and before its effects
 *   are queued. The step stays `running`. The watchdog is what retries it.
 * - `duplicate-effect` pushes the same `effect-queue` message a second time.
 *   The applier still applies that request key once.
 * - `jira-429` makes the next Jira call in the effect applier return HTTP 429.
 *   The existing retry path treats 429 as retryable. This module does not
 *   change the retry delay.
 *
 * The schedule lives in this process only. It is not a Forge entity, not a
 * KVS key, and not a run attribute. A cold start forgets it. Which kill,
 * duplicate, or 429 is still waiting to heal is the same kind of memory:
 * the counters themselves are written onto `run.budget.chaos` by
 * `chaos/counters.js` when one of them moves.
 *
 * The gate is closed unless the caller passes an environment that is
 * explicitly the simulator or the Forge development environment:
 *
 * - `CONDUCTOR_FAULT_INJECTION=simulation` and `CONDUCTOR_SIMULATION=1`.
 *   The simulator sets both. A Forge install does not set `CONDUCTOR_SIMULATION`.
 * - `CONDUCTOR_FAULT_INJECTION=development` and `CONDUCTOR_APP_ENV=development`.
 *   Set those two Forge variables in development only, if a live demo needs
 *   the same switch. Do not set them in staging or production.
 *
 * `CONDUCTOR_APP_ENV=production` or `staging` closes the gate even when the
 * other variables are present. With the gate closed, `injectFault` stores
 * nothing and the three hooks return without changing the worker, the queue,
 * or the Jira client.
 *
 * @module chaos/faults
 */

/** Forge variable / simulator env. Value is `simulation` or `development`. */
export const FAULT_INJECTION_ENV = 'CONDUCTOR_FAULT_INJECTION';

/**
 * Set to `1` by the simulator only. Production code never sets this.
 * Required together with `CONDUCTOR_FAULT_INJECTION=simulation`.
 */
export const SIMULATION_ENV = 'CONDUCTOR_SIMULATION';

/**
 * Name of the Forge environment this install is running in.
 * Fault injection accepts only `development`. `production` and `staging`
 * force the gate closed.
 */
export const APP_ENV = 'CONDUCTOR_APP_ENV';

/** Fault names the dev-dispatch body and the tests may arm. */
export const FAULT_TYPES = Object.freeze([
  'kill-worker',
  'duplicate-effect',
  'jira-429',
]);

/**
 * One armed fault waiting for the matching hook.
 *
 * @typedef {object} ArmedFault
 * @property {string} id
 * @property {'kill-worker'|'duplicate-effect'|'jira-429'} type
 * @property {string} [stepId] Kill only this step. Omit to kill the next one.
 * @property {string} [requestKey] Duplicate or 429 only this effect. Omit for the next one.
 * @property {number} [retryAfterSeconds] `Retry-After` header on an injected 429. Default 1.
 */

/** @type {ArmedFault[]} */
let pending = [];

let sequence = 0;

/**
 * Outstanding kills, keyed by step id. The watchdog claims the entry when
 * it retries that step. A cold start forgets it, same as the schedule.
 *
 * @type {Map<string, string>}
 */
const killedSteps = new Map();

/**
 * Request keys whose extra queue message has not been dropped yet.
 * The value is the run the counter belongs to.
 *
 * @type {Map<string, string>}
 */
const duplicateKeys = new Map();

/**
 * Request keys that were answered with an injected 429 and have not yet
 * been applied on the retry.
 *
 * @type {Map<string, string>}
 */
const rateLimitKeys = new Map();

/**
 * Request keys that already completed one Jira mutation while the gate
 * was open. A second successful mutation of the same key is a duplicate
 * write. The set is process memory. It is not a KVS row.
 *
 * @type {Set<string>}
 */
const writtenKeys = new Set();

/**
 * Drop every armed fault, every heal marker, and the id counter.
 * Tests and the simulator call this when a world closes so one scenario
 * cannot leak into the next. The id counter is process memory, same as
 * the schedule. Leaving it to climb made the next scenario's first fault
 * id depend on how many faults the earlier scenarios had armed.
 *
 * @returns {void}
 */
export function resetFaultInjection() {
  pending = [];
  sequence = 0;
  killedSteps.clear();
  duplicateKeys.clear();
  rateLimitKeys.clear();
  writtenKeys.clear();
}

/**
 * What the last scenario left in the in-process schedule.
 * `null` means the next scenario starts from an empty schedule and
 * `fault-1`. The simulator checks this before it builds a world, so a
 * missed `close()` fails the next scenario instead of changing its ids.
 *
 * @returns {string|null}
 */
export function faultInjectionResidue() {
  const parts = [];
  if (pending.length > 0) parts.push(`${pending.length} armed`);
  if (killedSteps.size > 0) parts.push(`${killedSteps.size} kill marker(s)`);
  if (duplicateKeys.size > 0) parts.push(`${duplicateKeys.size} duplicate marker(s)`);
  if (rateLimitKeys.size > 0) parts.push(`${rateLimitKeys.size} rate-limit marker(s)`);
  if (writtenKeys.size > 0) parts.push(`${writtenKeys.size} written key(s)`);
  if (sequence !== 0) parts.push(`id counter ${sequence}`);
  return parts.length === 0 ? null : parts.join(', ');
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Remember a kill so the watchdog can count the retry as a heal.
 * A closed gate stores nothing.
 *
 * @param {string} stepId
 * @param {string} runId
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean} True when the marker was stored.
 */
export function rememberKill(stepId, runId, env = process.env) {
  if (!isFaultInjectionEnabled(env)) return false;
  if (!nonEmpty(stepId) || !nonEmpty(runId)) return false;
  killedSteps.set(stepId, runId);
  return true;
}

/**
 * Take the kill marker for one step. A closed gate returns null and
 * leaves the marker, so a later open gate can still heal it.
 *
 * @param {string} stepId
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null} Run id the kill was recorded against.
 */
export function claimKillHeal(stepId, env = process.env) {
  if (!isFaultInjectionEnabled(env)) return null;
  if (!nonEmpty(stepId) || !killedSteps.has(stepId)) return null;
  const runId = killedSteps.get(stepId) ?? null;
  killedSteps.delete(stepId);
  return runId;
}

/**
 * Remember a duplicate push so the applier can count the drop as a heal.
 *
 * @param {string} requestKey
 * @param {string} runId
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function rememberDuplicate(requestKey, runId, env = process.env) {
  if (!isFaultInjectionEnabled(env)) return false;
  if (!nonEmpty(requestKey) || !nonEmpty(runId)) return false;
  duplicateKeys.set(requestKey, runId);
  return true;
}

/**
 * @param {string} requestKey
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
export function claimDuplicateHeal(requestKey, env = process.env) {
  if (!isFaultInjectionEnabled(env)) return null;
  if (!nonEmpty(requestKey) || !duplicateKeys.has(requestKey)) return null;
  const runId = duplicateKeys.get(requestKey) ?? null;
  duplicateKeys.delete(requestKey);
  return runId;
}

/**
 * Remember an injected 429 so the successful retry can count as a heal.
 *
 * @param {string} requestKey
 * @param {string} runId
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function rememberRateLimit(requestKey, runId, env = process.env) {
  if (!isFaultInjectionEnabled(env)) return false;
  if (!nonEmpty(requestKey) || !nonEmpty(runId)) return false;
  rateLimitKeys.set(requestKey, runId);
  return true;
}

/**
 * @param {string} requestKey
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
export function claimRateLimitHeal(requestKey, env = process.env) {
  if (!isFaultInjectionEnabled(env)) return null;
  if (!nonEmpty(requestKey) || !rateLimitKeys.has(requestKey)) return null;
  const runId = rateLimitKeys.get(requestKey) ?? null;
  rateLimitKeys.delete(requestKey);
  return runId;
}

/**
 * Note one successful Jira mutation for a request key.
 *
 * The first success returns false. A later success for the same key
 * returns true: that is a duplicate write. A closed gate returns false
 * and does not remember the key, so production applies do not accumulate
 * anything in this process.
 *
 * @param {string} requestKey
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean} True when this key was already written once.
 */
export function rememberJiraWrite(requestKey, env = process.env) {
  if (!isFaultInjectionEnabled(env)) return false;
  if (!nonEmpty(requestKey)) return false;
  if (writtenKeys.has(requestKey)) return true;
  writtenKeys.add(requestKey);
  return false;
}

/**
 * @param {Record<string, string|undefined>|null|undefined} env
 * @param {string} name
 * @returns {string}
 */
function readEnv(env, name) {
  if (!env || typeof env !== 'object') return '';
  const raw = env[name];
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/**
 * True only for the simulator or the development environment.
 *
 * Production and staging are refused first, before the mode is read, so a
 * copied variable cannot arm a fault there.
 *
 * @param {Record<string, string|undefined>} [env] Environment-like object.
 *   Defaults to `process.env`. Tests pass their own object and leave
 *   `process.env` alone.
 * @returns {boolean}
 */
export function isFaultInjectionEnabled(env = process.env) {
  const appEnv = readEnv(env, APP_ENV);
  if (appEnv === 'production' || appEnv === 'staging' || appEnv === 'prod') {
    return false;
  }
  const mode = readEnv(env, FAULT_INJECTION_ENV);
  if (mode === 'simulation') {
    const simulation = readEnv(env, SIMULATION_ENV);
    return simulation === '1' || simulation === 'true';
  }
  if (mode === 'development') {
    return appEnv === 'development';
  }
  return false;
}

/**
 * Arm one fault. A closed gate returns `{armed: false, reason: 'disabled'}`
 * and does not store the spec, including when the type is unknown. Callers
 * cannot probe the feature by its error text while the flag is off.
 *
 * @param {any} spec `{type, stepId?, requestKey?, retryAfterSeconds?}`
 * @param {Record<string, string|undefined>} [env]
 * @returns {{armed: false, reason: string}|{armed: true, id: string, type: string}}
 */
export function injectFault(spec, env = process.env) {
  if (!isFaultInjectionEnabled(env)) {
    return { armed: false, reason: 'disabled' };
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { armed: false, reason: 'invalid' };
  }
  const type = spec.type;
  if (!FAULT_TYPES.includes(type)) {
    return { armed: false, reason: 'unknown-type' };
  }
  sequence += 1;
  /** @type {ArmedFault} */
  const fault = {
    id: `fault-${sequence}`,
    type,
  };
  if (typeof spec.stepId === 'string' && spec.stepId.length > 0) {
    fault.stepId = spec.stepId;
  }
  if (typeof spec.requestKey === 'string' && spec.requestKey.length > 0) {
    fault.requestKey = spec.requestKey;
  }
  if (type === 'jira-429') {
    const retryAfter = spec.retryAfterSeconds;
    fault.retryAfterSeconds = Number.isInteger(retryAfter) && retryAfter >= 0 && retryAfter <= 60
      ? retryAfter
      : 1;
  }
  pending.push(fault);
  return { armed: true, id: fault.id, type };
}

/**
 * Remove the first fault of `type` that `match` accepts.
 * A closed gate returns null and leaves the queue alone.
 *
 * @param {'kill-worker'|'duplicate-effect'|'jira-429'} type
 * @param {Record<string, string|undefined>} env
 * @param {(fault: ArmedFault) => boolean} match
 * @returns {ArmedFault|null}
 */
function take(type, env, match) {
  if (!isFaultInjectionEnabled(env)) return null;
  const index = pending.findIndex((fault) => fault.type === type && match(fault));
  if (index < 0) return null;
  const [fault] = pending.splice(index, 1);
  return fault;
}

/**
 * The kill hook for one running step. The step worker calls this from
 * `ctx.faultCheckpoint` after the worker has started its own reads.
 *
 * @param {{stepId?: string}|null|undefined} step
 * @param {Record<string, string|undefined>} [env]
 * @returns {ArmedFault|null}
 */
export function takeKillWorker(step, env = process.env) {
  const stepId = step && typeof step.stepId === 'string' ? step.stepId : '';
  if (!stepId) return null;
  return take('kill-worker', env, (fault) => !fault.stepId || fault.stepId === stepId);
}

/**
 * The duplicate hook for one effect that was just pushed.
 * A fault with no `requestKey` matches the next effect. A fault that names
 * a key waits until that key is pushed.
 *
 * @param {string} requestKey
 * @param {Record<string, string|undefined>} [env]
 * @returns {ArmedFault|null}
 */
export function takeDuplicateEffect(requestKey, env = process.env) {
  if (typeof requestKey !== 'string' || requestKey.length === 0) return null;
  return take(
    'duplicate-effect',
    env,
    (fault) => !fault.requestKey || fault.requestKey === requestKey,
  );
}

/**
 * The 429 hook for one Jira call inside the effect applier.
 * Same matching rule as {@link takeDuplicateEffect}.
 *
 * @param {string} requestKey Effect being applied.
 * @param {Record<string, string|undefined>} [env]
 * @returns {ArmedFault|null}
 */
export function takeJira429(requestKey, env = process.env) {
  if (typeof requestKey !== 'string' || requestKey.length === 0) return null;
  return take(
    'jira-429',
    env,
    (fault) => !fault.requestKey || fault.requestKey === requestKey,
  );
}

/**
 * A `fetch` Response with status 429 and a `Retry-After` header.
 *
 * The effect applier already treats status 429 as retryable. The header is
 * what the retry waits on, capped at the queue maximum of 900 seconds. The
 * fault's own `retryAfterSeconds` stays in 0–60. A 429 with no header still
 * uses the applier's exponential backoff.
 *
 * @param {number} retryAfterSeconds
 * @returns {Response}
 */
export function jira429Response(retryAfterSeconds) {
  const seconds = Number.isInteger(retryAfterSeconds) && retryAfterSeconds >= 0
    ? retryAfterSeconds
    : 1;
  return new Response(
    JSON.stringify({
      errorMessages: ['Fault injection returned a Jira 429.'],
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(seconds),
      },
    },
  );
}
