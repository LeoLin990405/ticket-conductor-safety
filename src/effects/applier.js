/**
 * Effect applier: the consumer behind `effect-queue` (WP2).
 *
 * Reliability model
 * -----------------
 * - The store's `putEffectIfAbsent` makes enqueueing idempotent by requestKey.
 * - The consumer re-reads the effect before applying it. An `applied` or
 *   `failed` effect is never sent to Jira again.
 * - Queue delivery is at-least-once, so duplicate events are expected. A small
 *   in-process per-key lock serialises concurrent deliveries of the same key
 *   inside one function instance.
 * - Failures increment `tries`, move the effect to `retrying`, and re-push the
 *   same `{ requestKey }` message with a platform `delayInSeconds`. A Jira
 *   429 that includes `Retry-After` waits that long (capped at 900 seconds,
 *   the queue maximum) instead of the fixed backoff. After five attempts the
 *   effect becomes `failed` and its step becomes `blocked`.
 *
 * Cross-instance races use `updateEffect(..., { expectedStatus })`. That
 * compare-and-set moves `pending` or `retrying` to `applying` before Jira is
 * called. The loser sees a conflict and does not call Jira. The in-process
 * lock still serialises duplicate deliveries inside one warm instance.
 *
 * @module effects/applier
 */

import { recordDuplicateHealed, recordFaultInjected, recordJiraWrite, safeChaos } from '../chaos/counters.js';
import { isFaultInjectionEnabled, jira429Response, takeJira429 } from '../chaos/faults.js';
import { recordEvent } from '../recorder/log.js';
import { isBudgetStopNoted, isForwardEffect, refuseEffectForBudgetStop } from '../run/budget.js';
import { getStore } from '../store/index.js';
import { EffectValidationError } from './errors.js';
import { applyJiraEffect } from './jira.js';
import { noteEffectDeduped } from './metrics.js';
import { buildEffectEvent, pushEffectEvent } from './queue.js';

/**
 * Total attempts, including the first one. The fifth failure is terminal.
 * @constant {number}
 */
export const MAX_EFFECT_TRIES = 5;

/** Wait before re-checking a deferred child issue key. @constant {number} */
export const CHILD_KEY_WAIT_SECONDS = 5;

/** Slower re-check once a deferred comment has waited a minute. @constant {number} */
export const CHILD_KEY_SLOW_WAIT_SECONDS = 30;

/**
 * Give up on a deferred comment whose child issue key has not appeared after
 * this long (the step's createIssue was lost, e.g. a queue push refused during
 * a deploy). Without a cap the effect re-pushes itself forever.
 * @constant {number}
 */
export const CHILD_KEY_MAX_WAIT_MS = 20 * 60 * 1000;

/** First retry delay. Later retries double it. @constant {number} */
export const RETRY_BASE_SECONDS = 5;

/** Platform maximum for `delayInSeconds`. @constant {number} */
export const MAX_RETRY_DELAY_SECONDS = 900;

/**
 * Exponential backoff for the queue's `delayInSeconds`.
 *
 * Failed attempt 1 waits 5 s, attempt 2 waits 10 s, attempt 3 waits 20 s, and
 * attempt 4 waits 40 s. The fifth failure is terminal and is not re-pushed.
 *
 * @param {number} failedAttempt 1-based number of the attempt that failed.
 * @returns {number} Delay in whole seconds.
 */
export function retryDelaySeconds(failedAttempt) {
  const attempt = Math.max(1, Math.floor(failedAttempt));
  return Math.min(
    MAX_RETRY_DELAY_SECONDS,
    RETRY_BASE_SECONDS * 2 ** (attempt - 1),
  );
}

/**
 * Turn a `Retry-After` header into whole seconds, or `undefined` when the
 * header is missing or not a delay this applier understands.
 *
 * Delta-seconds (`"30"`) is what Jira Cloud sends. An HTTP-date is the
 * other form the HTTP spec allows. The date is compared with `nowMs`,
 * which is the simulator clock when a test installed one, so a header of
 * "30 seconds from the fake now" does not depend on the wall clock.
 * A date in the past means the caller may retry immediately (`0`).
 *
 * @param {unknown} raw Header value copied onto the apply error.
 * @param {number} nowMs Clock the date form is measured against.
 * @returns {number|undefined}
 */
export function parseRetryAfterSeconds(raw, nowMs) {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (text.length === 0) return undefined;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return undefined;
  const deltaMs = parsed - nowMs;
  if (!Number.isFinite(deltaMs)) return undefined;
  if (deltaMs <= 0) return 0;
  return Math.ceil(deltaMs / 1000);
}

/**
 * Delay for one failed attempt.
 *
 * A 429 with a usable `Retry-After` waits that long, capped at
 * {@link MAX_RETRY_DELAY_SECONDS}. The header replaces the backoff,
 * including when it is shorter: Jira is telling us when the next call is
 * allowed. A 429 with no header, a header we cannot parse, or any other
 * status keeps {@link retryDelaySeconds}.
 *
 * @param {number} failedAttempt 1-based number of the attempt that failed.
 * @param {unknown} error The error `applyJiraEffect` threw.
 * @param {number} [nowMs] Clock for an HTTP-date `Retry-After`.
 * @returns {number} Delay in whole seconds, from 0 through 900.
 */
export function retryDelayForFailure(failedAttempt, error, nowMs = Date.now()) {
  const backoff = retryDelaySeconds(failedAttempt);
  if (!error || typeof error !== 'object') return backoff;
  const source = /** @type {Record<string, unknown>} */ (error);
  if (source.status !== 429) return backoff;
  const header = parseRetryAfterSeconds(source.retryAfter, nowMs);
  if (header === undefined) return backoff;
  return Math.min(MAX_RETRY_DELAY_SECONDS, Math.max(0, header));
}

/**
 * Reduce an unknown thrown value to a small JSON-safe object for step.error.
 *
 * @param {unknown} error
 * @returns {{name: string, message: string, code?: string, status?: number}}
 */
export function serializeError(error) {
  if (error && typeof error === 'object') {
    const source = /** @type {Record<string, unknown>} */ (error);
    /** @type {{name: string, message: string, code?: string, status?: number}} */
    const serialized = {
      name: typeof source.name === 'string' ? source.name : 'Error',
      message:
        typeof source.message === 'string'
          ? source.message
          : String(error),
    };
    if (typeof source.code === 'string') {
      serialized.code = source.code;
    }
    if (typeof source.status === 'number') {
      serialized.status = source.status;
    }
    return serialized;
  }
  return { name: 'Error', message: String(error) };
}

/**
 * Pull the request key out of a Forge consumer event.
 *
 * Forge delivers `{ body: { requestKey } }`. Accepting a direct
 * `{ requestKey }` as well keeps local tests and manual re-pushes simple.
 *
 * @param {{body?: any, requestKey?: string}|null|undefined} event
 * @returns {string}
 */
export function extractRequestKey(event) {
  if (!event || typeof event !== 'object') {
    throw new EffectValidationError('effect applier event is required');
  }
  let body = event.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      throw new EffectValidationError(
        'effect applier event.body must be JSON or an object',
      );
    }
  }
  const requestKey =
    body && typeof body === 'object'
      ? body.requestKey
      : /** @type {any} */ (event).requestKey;
  if (typeof requestKey !== 'string' || requestKey.length === 0) {
    throw new EffectValidationError(
      'effect applier event must contain body.requestKey',
    );
  }
  return requestKey;
}

/**
 * @param {object|null|undefined} logger
 * @param {'info'|'warn'|'error'} level
 * @param {string} message
 * @param {Record<string, unknown>} [data]
 * @returns {void}
 */
function log(logger, level, message, data) {
  const method = logger && logger[level];
  if (typeof method === 'function') {
    if (data === undefined) {
      method.call(logger, message);
    } else {
      method.call(logger, message, data);
    }
  }
}

/**
 * Resolve a dependency that may be supplied directly or through a getter.
 *
 * @param {Record<string, any>} deps
 * @param {string} name
 * @returns {any}
 */
function resolveSyncDependency(deps, name) {
  const getter = deps[`get${name[0].toUpperCase()}${name.slice(1)}`];
  if (typeof getter === 'function') {
    return getter();
  }
  return deps[name];
}

/**
 * @param {Record<string, any>} deps
 * @returns {any}
 */
function resolveStore(deps) {
  const store = resolveSyncDependency(deps, 'store');
  if (!store || typeof store.putEffectIfAbsent !== 'function') {
    throw new EffectValidationError('effect applier needs a store');
  }
  return store;
}

/**
 * @param {Record<string, any>} deps
 * @returns {Promise<Function>}
 */
async function resolveRequestJira(deps) {
  const requestJira = await resolveSyncDependency(deps, 'requestJira');
  if (typeof requestJira !== 'function') {
    throw new EffectValidationError('effect applier needs requestJira');
  }
  return requestJira;
}

/**
 * Environment the fault gate reads. An explicit `env` on this applier wins.
 * The default applier passes `getEnv`, which reads the simulator's env.
 * Production leaves both unset, so this is `process.env`, and the gate is
 * closed unless the development variables are set.
 *
 * @param {Record<string, any>} deps
 * @returns {Record<string, string|undefined>}
 */
function faultEnvironment(deps) {
  if (deps.env && typeof deps.env === 'object') return deps.env;
  if (typeof deps.getEnv === 'function') {
    const value = deps.getEnv();
    if (value && typeof value === 'object') return value;
  }
  return process.env;
}

/**
 * Return `requestJira` unchanged when the gate is closed. When it is open,
 * the first call that matches an armed `jira-429` fault returns that
 * response and does not call Jira. Later calls in the same attempt, and the
 * retry, call the real client.
 *
 * @param {Function} requestJira
 * @param {Record<string, string|undefined>} env
 * @param {string} requestKey
 * @param {string} runId Run the counter is stored on. Empty when the effect has none.
 * @param {any} store
 * @param {object|null|undefined} logger
 * @returns {Function}
 */
function guardJira429(requestJira, env, requestKey, runId, store, logger) {
  if (!isFaultInjectionEnabled(env)) return requestJira;
  return async (path, init) => {
    const fault = takeJira429(requestKey, env);
    if (!fault) return requestJira(path, init);
    // The 429 is the injection. The heal is the later apply that succeeds.
    // Count before returning so a retry cannot observe the effect as
    // retrying with `injected` still at 0.
    await safeChaos(logger, () => recordFaultInjected(store, {
      runId,
      requestKey,
      kind: 'jira-429',
    }, env));
    return jira429Response(fault.retryAfterSeconds ?? 1);
  };
}

/**
 * @param {Record<string, any>} deps
 * @returns {Promise<object|Function>}
 */
async function resolveQueue(deps) {
  const queue = await resolveSyncDependency(deps, 'queue');
  if (!queue) {
    throw new EffectValidationError('effect applier needs an effect queue');
  }
  return queue;
}

/**
 * Build a per-requestKey promise chain. Only one delivery for a key runs at a
 * time inside this applier instance; different keys still run concurrently.
 *
 * @param {Map<string, Promise<void>>} locks
 * @param {string} key
 * @param {() => Promise<any>} task
 * @returns {Promise<any>}
 */
async function withKeyLock(locks, key, task) {
  const previous = locks.get(key) ?? Promise.resolve();
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const tail = previous.then(
    () => gate,
    () => gate,
  );
  locks.set(key, tail);

  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (locks.get(key) === tail) {
      locks.delete(key);
    }
  }
}

/**
 * Mark the owning step blocked after a terminal effect failure.
 *
 * A completed step is left alone: a late duplicate failure must not rewrite a
 * step that has already finished. Missing steps are ignored so one bad effect
 * cannot fail the whole consumer event.
 *
 * @param {any} store
 * @param {import('../store/types.js').Effect} effect
 * @param {unknown} error
 * @param {object|null|undefined} logger
 * @returns {Promise<any>}
 */
async function blockStep(store, effect, error, logger) {
  if (!effect.stepId) {
    return null;
  }
  try {
    const step = await store.getStep(effect.stepId);
    if (!step) {
      return null;
    }
    if (step.status === 'done') {
      return step;
    }
    const updated = await store.updateStep(effect.stepId, {
      status: 'blocked',
      error: serializeError(error),
    });
    try {
      const { recordFailureLesson } = await import('../memory/lessons.js');
      const run = await store.getRun(updated.runId);
      if (run) {
        await recordFailureLesson({
          store,
          run,
          step: updated,
          status: 'blocked',
          error,
          kind: 'step-blocked',
        });
      }
    } catch (lessonError) {
      log(logger, 'warn', 'Could not record a failure lesson', {
        stepId: effect.stepId,
        error: serializeError(lessonError),
      });
    }
    return updated;
  } catch (stepError) {
    log(logger, 'error', 'Failed to block step after effect failure', {
      stepId: effect.stepId,
      requestKey: effect.requestKey,
      error: serializeError(stepError),
    });
    return null;
  }
}

/**
 * Copy a created child issue key onto its step. This runs after the effect is
 * marked applied, so a failure here cannot cause a duplicate Jira issue.
 *
 * @param {any} store
 * @param {import('../store/types.js').Effect} effect
 * @param {Record<string, unknown>} result
 * @param {object|null|undefined} logger
 * @returns {Promise<void>}
 */
async function recordChildIssueKey(store, effect, result, logger) {
  if (effect.kind !== 'createIssue' || !effect.stepId) {
    return;
  }
  const issueKey = result.issueKey;
  if (typeof issueKey !== 'string' || issueKey.length === 0) {
    return;
  }
  try {
    const step = await store.getStep(effect.stepId);
    if (!step || step.childIssueKey === issueKey) {
      return;
    }
    await store.updateStep(effect.stepId, { childIssueKey: issueKey });
  } catch (error) {
    log(logger, 'error', 'Failed to record childIssueKey on step', {
      stepId: effect.stepId,
      requestKey: effect.requestKey,
      issueKey,
      error: serializeError(error),
    });
  }
}

/**
 * Record a failed attempt and either schedule the retry or fail terminally.
 *
 * @param {{
 *   store: any,
 *   queue: object|Function,
 *   logger?: object|null,
 *   effect: import('../store/types.js').Effect,
 *   attempt: number,
 *   error: unknown,
 *   now?: () => number,
 * }} input
 * @returns {Promise<import('../store/types.js').Effect>}
 */
async function handleFailure(input) {
  const { store, queue, logger, effect, attempt, error, now } = input;
  const terminal = attempt >= MAX_EFFECT_TRIES;
  const status = terminal ? 'failed' : 'retrying';
  const serialized = serializeError(error);

  let updated;
  try {
    updated = await store.updateEffect(
      effect.requestKey,
      {
        status,
        tries: attempt,
      },
      { expectedStatus: 'applying' },
    );
  } catch (storeError) {
    if (storeError?.code === 'CONFLICT' || storeError?.name === 'ConflictError') {
      return store.getEffect(effect.requestKey);
    }
    log(logger, 'error', 'Failed to record effect failure', {
      requestKey: effect.requestKey,
      attempt,
      error: serializeError(storeError),
    });
    // Surface the original Jira failure; the queue may redeliver the event.
    throw error;
  }

  log(logger, terminal ? 'error' : 'warn', 'Effect apply failed', {
    requestKey: effect.requestKey,
    kind: effect.kind,
    attempt,
    status,
    error: serialized,
  });

  if (terminal) {
    await blockStep(store, updated, error, logger);
    return updated;
  }

  const nowMs = typeof now === 'function' ? now() : Date.now();
  const delayInSeconds = retryDelayForFailure(attempt, error, nowMs);
  try {
    await pushEffectEvent(
      queue,
      buildEffectEvent(effect.requestKey, delayInSeconds),
    );
  } catch (queueError) {
    // The effect stays `retrying`; WP4's watchdog re-pushes stuck effects.
    log(logger, 'error', 'Failed to re-push effect retry', {
      requestKey: effect.requestKey,
      delayInSeconds,
      error: serializeError(queueError),
    });
  }
  return updated;
}

/**
 * Create an effect consumer with injected dependencies.
 *
 * Each applier owns its per-key lock map. Production should create one applier
 * per warm function instance (see `index.js`); tests can create one per test.
 *
 * Dependencies may be passed directly (`store`, `requestJira`, `queue`) or as
 * getters (`getStore`, `getRequestJira`, `getQueue`). Getters let the default
 * singleton follow WP1's `setStore()` and lazy Forge module loading.
 *
 * @param {{
 *   store?: any,
 *   getStore?: () => any,
 *   requestJira?: Function,
 *   getRequestJira?: () => Function|Promise<Function>,
 *   queue?: object|Function,
 *   getQueue?: () => object|Function|Promise<object|Function>,
 *   logger?: object|null,
 * }} [deps]
 * @returns {(event: {body?: {requestKey?: string}}|{requestKey?: string}) => Promise<any>}
 */
export function createEffectApplier(deps = {}) {
  /** @type {Map<string, Promise<void>>} */
  const locks = new Map();
  const logger = deps.logger === undefined ? console : deps.logger;

  /**
   * @param {{body?: any, requestKey?: string}} event
   * @returns {Promise<import('../store/types.js').Effect|null>}
   */
  return async function effectApplier(event) {
    const requestKey = extractRequestKey(event);
    const store = resolveStore(deps);

    return withKeyLock(locks, requestKey, async () => {
      // Re-read inside the lock: another delivery may have applied it while
      // this one was waiting.
      const effect = await store.getEffect(requestKey);
      if (!effect) {
        log(logger, 'warn', 'Effect message references a missing effect', {
          requestKey,
        });
        return null;
      }
      if (effect.status === 'applied' || effect.status === 'failed') {
        // The row is already terminal. This delivery does not call Jira
        // and does not write the effect. The dedupe tally stays in process
        // memory unless a chaos counter write, which already updates the
        // run, can carry it. A closed gate skips that write.
        noteEffectDeduped(effect.runId);
        // Dropping an already-applied key is the heal for a duplicate
        // fault. A closed gate skips the await, so this return is the same
        // path production already took. `failed` is not a heal: the fault
        // we count is the one that still applied exactly once.
        const faultEnv = faultEnvironment(deps);
        if (effect.status === 'applied' && isFaultInjectionEnabled(faultEnv)) {
          await safeChaos(logger, () => recordDuplicateHealed(store, effect, faultEnv));
        }
        return effect;
      }
      // Another invocation already claimed this row. Leave it alone. The
      // watchdog turns a stale `applying` row back into `retrying`.
      if (effect.status === 'applying') {
        return effect;
      }
      if (effect.status !== 'pending' && effect.status !== 'retrying') {
        return effect;
      }

      // A budget stop notes the run before it drains rows. A message that
      // arrives in that window, or after the drain write was lost, fails
      // closed here and does not call Jira. Compensations are not forward
      // effects, so undo can still run.
      if (isForwardEffect(effect.kind) && isBudgetStopNoted(effect.runId)) {
        return refuseEffectForBudgetStop(store, effect, 'noted');
      }

      // A compensation lists the request keys that must be `applied` first.
      // `closeIssue` waits for every `recordRemovedComment` on that issue so
      // the delete is not racing the close. The keys live on the payload
      // because the effect entity has no dependency attribute. Re-push
      // without spending a try. An already `applied` row returned above, so
      // a redelivery does not call Jira again.
      const dependencyKeys = Array.isArray(effect.payload?.dependsOnKeys)
        ? effect.payload.dependsOnKeys.filter((key) => typeof key === 'string' && key.length > 0)
        : [];
      if (dependencyKeys.length > 0) {
        let blocked = null;
        let waiting = false;
        for (const key of dependencyKeys) {
          const dependency = await store.getEffect(key);
          if (dependency?.status === 'failed') {
            blocked = key;
            break;
          }
          if (!dependency || dependency.status !== 'applied') {
            waiting = true;
            break;
          }
        }
        if (blocked) {
          try {
            return await store.updateEffect(
              requestKey,
              {
                status: 'failed',
                result: {
                  name: 'CompensationDependencyFailed',
                  message: `compensation dependency ${blocked} failed`,
                },
              },
              { expectedStatus: effect.status },
            );
          } catch (storeError) {
            if (storeError?.code === 'CONFLICT' || storeError?.name === 'ConflictError') {
              return store.getEffect(requestKey);
            }
            throw storeError;
          }
        }
        if (waiting) {
          const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
          const waitedMs = nowMs - (Number(effect.updatedAt) || nowMs);
          if (waitedMs > CHILD_KEY_MAX_WAIT_MS) {
            try {
              return await store.updateEffect(
                requestKey,
                {
                  status: 'failed',
                  result: {
                    name: 'CompensationDependencyMissing',
                    message: `compensation dependencies were not applied after ${Math.round(waitedMs / 1000)}s`,
                  },
                },
                { expectedStatus: effect.status },
              );
            } catch (storeError) {
              if (storeError?.code === 'CONFLICT' || storeError?.name === 'ConflictError') {
                return store.getEffect(requestKey);
              }
              throw storeError;
            }
          }
          try {
            const queue = await resolveQueue(deps);
            await pushEffectEvent(
              queue,
              buildEffectEvent(
                requestKey,
                waitedMs > 60_000 ? CHILD_KEY_SLOW_WAIT_SECONDS : CHILD_KEY_WAIT_SECONDS,
              ),
            );
          } catch (queueError) {
            log(logger, 'error', 'Failed to re-push compensation waiting on a dependency', {
              requestKey,
              error: serializeError(queueError),
            });
          }
          return effect;
        }
      }

      // A step comment with a deferred child key: wait for the step's
      // createIssue effect to record `childIssueKey`. Re-push without spending
      // a try; the watchdog re-pushes a pending row if this push is lost.
      let toApply = null;
      if (
        effect.kind === 'comment' &&
        effect.payload &&
        !effect.payload.issueKey &&
        typeof effect.payload.childOfStepId === 'string'
      ) {
        const owner = await store.getStep(effect.payload.childOfStepId);
        const childKey = owner?.childIssueKey;
        if (!childKey) {
          if (owner && (owner.status === 'blocked' || owner.status === 'failed')) {
            // The child issue will never exist; stop polling.
            return effect;
          }
          if (!owner) {
            const queue = await resolveQueue(deps);
            return handleFailure({
              store, queue, logger, effect,
              attempt: MAX_EFFECT_TRIES,
              error: new Error(`step ${effect.payload.childOfStepId} not found for deferred comment`),
            });
          }
          const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
          const waitedMs = nowMs - (Number(effect.updatedAt) || nowMs);
          if (waitedMs > CHILD_KEY_MAX_WAIT_MS) {
            log(logger, 'warn', 'Deferred comment gave up: child issue key never appeared', {
              requestKey,
              stepId: effect.payload.childOfStepId,
              waitedMs,
            });
            try {
              return await store.updateEffect(
                requestKey,
                {
                  status: 'failed',
                  // The deployed effect entity has no `error` attribute; `result` is `any`.
                  result: { name: 'ChildIssueMissing', message: `step ${effect.payload.childOfStepId} has no child issue key after ${Math.round(waitedMs / 1000)}s` },
                },
                { expectedStatus: effect.status },
              );
            } catch (storeError) {
              if (storeError?.code === 'CONFLICT' || storeError?.name === 'ConflictError') {
                return store.getEffect(requestKey);
              }
              throw storeError;
            }
          }
          try {
            const queue = await resolveQueue(deps);
            await pushEffectEvent(
              queue,
              buildEffectEvent(
                requestKey,
                waitedMs > 60_000 ? CHILD_KEY_SLOW_WAIT_SECONDS : CHILD_KEY_WAIT_SECONDS,
              ),
            );
          } catch (queueError) {
            log(logger, 'error', 'Failed to re-push deferred comment', {
              requestKey,
              error: serializeError(queueError),
            });
          }
          return effect;
        }
        toApply = { ...effect.payload, issueKey: childKey };
      }

      const faultEnv = faultEnvironment(deps);
      const requestJira = guardJira429(
        await resolveRequestJira(deps),
        faultEnv,
        requestKey,
        typeof effect.runId === 'string' ? effect.runId : '',
        store,
        logger,
      );
      const attempt = (effect.tries ?? 0) + 1;
      let claimed;
      try {
        claimed = await store.updateEffect(
          requestKey,
          { status: 'applying', tries: attempt },
          { expectedStatus: effect.status },
        );
      } catch (error) {
        if (error?.code === 'CONFLICT' || error?.name === 'ConflictError') {
          // Another delivery already claimed this row. That delivery is
          // the one that may call Jira. This one is a dedupe, and it does
          // not write.
          noteEffectDeduped(effect.runId);
          return store.getEffect(requestKey);
        }
        throw error;
      }

      try {
        let result = await applyJiraEffect(
          toApply ? { ...claimed, payload: toApply } : claimed,
          { requestJira },
        );
        // A deferred child comment stores `childOfStepId` and learns the
        // issue key only at apply time. Keep that key on the result so undo
        // can find the comment without a second query. Comments that already
        // named `payload.issueKey` keep the previous `{commentId}` result,
        // so their stored row does not grow.
        if (
          claimed.kind === 'comment' &&
          toApply &&
          typeof toApply.issueKey === 'string' &&
          !claimed.payload?.issueKey &&
          result &&
          typeof result === 'object' &&
          typeof result.issueKey !== 'string'
        ) {
          result = { ...result, issueKey: toApply.issueKey };
        }
        let applied;
        try {
          applied = await store.updateEffect(
            requestKey,
            {
              status: 'applied',
              tries: attempt,
              result,
            },
            { expectedStatus: 'applying' },
          );
        } catch (error) {
          if (error?.code === 'CONFLICT' || error?.name === 'ConflictError') {
            return store.getEffect(requestKey);
          }
          throw error;
        }
        await recordChildIssueKey(store, applied, result, logger);
        if (typeof applied.runId === 'string' && applied.runId.length > 0) {
          let stepIdx;
          if (typeof applied.stepId === 'string' && typeof store.getStep === 'function') {
            const owner = await store.getStep(applied.stepId);
            if (Number.isInteger(owner?.idx)) {
              stepIdx = owner.idx;
            }
          }
          await recordEvent(store, {
            runId: applied.runId,
            kind: 'effect.written',
            stepId: applied.stepId,
            stepIdx,
            journalKey: applied.requestKey,
            detail: {
              phase: 'applied',
              kind: applied.kind,
              requestKey: applied.requestKey,
              status: 'applied',
              result: applied.result,
            },
          });
        }
        // The mutation finished once. Remember the key, heal a 429 if this
        // was its retry, and count a second mutation if this key was
        // already written. A closed gate does not await.
        if (isFaultInjectionEnabled(faultEnv)) {
          await safeChaos(logger, () => recordJiraWrite(store, applied, faultEnv));
        }
        return applied;
      } catch (error) {
        const queue = await resolveQueue(deps);
        return handleFailure({
          store,
          queue,
          logger,
          effect: claimed,
          attempt,
          error,
          now: deps.now,
        });
      }
    });
  };
}

/**
 * Apply one effect by request key using the supplied dependencies. Mostly a
 * convenience for tests and admin tooling; production uses `effectApplierHandler`.
 *
 * @param {string} requestKey
 * @param {Parameters<typeof createEffectApplier>[0]} [deps]
 * @returns {Promise<import('../store/types.js').Effect|null>}
 */
export function applyEffect(requestKey, deps = {}) {
  const applier = createEffectApplier({ store: getStore(), ...deps });
  return applier({ body: { requestKey } });
}
