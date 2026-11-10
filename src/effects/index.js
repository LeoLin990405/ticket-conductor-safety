/**
 * Public WP2 interface: idempotent Jira effects and their queue consumer.
 *
 * ```js
 * import { enqueueEffect, effectApplierHandler } from '../effects/index.js';
 *
 * const { requestKey, created } = await enqueueEffect({
 *   runId,
 *   stepId,
 *   kind: 'createIssue',
 *   payload: { projectKey, parentKey, summary, description, issueType },
 *   discriminator: 'child-issue',
 * });
 * ```
 *
 * Production uses lazy Forge modules:
 * - `enqueueEffect` loads `@forge/events` and pushes `{body:{requestKey}}` to
 *   the `effect-queue`.
 * - `effectApplierHandler` loads `@forge/api` and calls Jira as the app.
 *
 * Tests install WP1's memory store with `setStore(createMemoryStore())`, then
 * either `configureEffects({queue, requestJira})` or pass those dependencies
 * directly to the handler. Importing this module has no Forge side effects.
 *
 * @module effects
 */

import { recordEvent } from '../recorder/log.js';
import { recordFaultInjected, safeChaos } from '../chaos/counters.js';
import { resetFaultInjection, takeDuplicateEffect } from '../chaos/faults.js';
import { hasPendingEffectMetrics, noteEffectDeduped, resetEffectMetrics } from './metrics.js';
import { getStore as getDefaultStore } from '../store/index.js';
import { EFFECT_KINDS } from '../store/types.js';
import { createEffectApplier } from './applier.js';
import { EffectValidationError } from './errors.js';
import { validateEffectPayload } from './jira.js';
import {
  buildEffectEvent,
  createForgeQueue,
  pushEffectEvent,
} from './queue.js';
import { requestKeyFor } from './requestKey.js';

export {
  applyEffect,
  createEffectApplier,
  extractRequestKey,
  MAX_EFFECT_TRIES,
  MAX_RETRY_DELAY_SECONDS,
  parseRetryAfterSeconds,
  retryDelayForFailure,
  retryDelaySeconds,
  serializeError,
} from './applier.js';
export {
  combineEffectMetrics,
  effectMetricsFromEffects,
  hasPendingEffectMetrics,
  noteEffectDeduped,
  pendingEffectDeduped,
  resetEffectMetrics,
} from './metrics.js';
export { readRetryAfterHeader } from './jira.js';
export {
  EffectApplyError,
  EffectError,
  EffectValidationError,
} from './errors.js';
export {
  applyJiraEffect,
  normalizeAdf,
  textToAdf,
  validateEffectPayload,
} from './jira.js';
export {
  buildEffectEvent,
  createForgeQueue,
  EFFECT_QUEUE_NAME,
  pushEffectEvent,
} from './queue.js';
export { normalizeDiscriminator, requestKeyFor } from './requestKey.js';

/**
 * Dependency overrides installed by tests or by an embedding application.
 *
 * @type {{
 *   store: any,
 *   queue: any,
 *   requestJira: Function|null,
 *   logger: object|null,
 *   env: Record<string, string|undefined>|null,
 *   now: (() => number)|null,
 * }}
 */
let overrides = {
  store: null,
  queue: null,
  requestJira: null,
  logger: console,
  env: null,
  // Null until a test installs the simulator clock. Production reads
  // `Date.now()` when this stays null. See `getDefaultApplier`.
  now: null,
};

/** Lazily-created `effect-queue` adapter. @type {{push: Function}|null} */
let forgeQueue = null;

/** Cached lazy `asApp().requestJira` wrapper. @type {Promise<Function>|null} */
let forgeRequestJiraPromise = null;

/** The default applier holds the in-process per-requestKey lock map. */
let defaultApplier = null;

/**
 * @returns {any}
 */
function configuredStore() {
  return overrides.store ?? getDefaultStore();
}

/**
 * @returns {object|Function}
 */
function configuredQueue() {
  if (overrides.queue) {
    return overrides.queue;
  }
  forgeQueue ??= createForgeQueue();
  return forgeQueue;
}

/**
 * Create the production Jira request function lazily.
 *
 * `@forge/api` is not imported at module load time, so this package can be
 * unit-tested without Forge runtime modules being installed. The app system
 * user performs effect mutations; actions/workers never call Jira directly.
 *
 * @returns {Promise<(path: string, init?: object) => Promise<any>>}
 */
function configuredRequestJira() {
  if (overrides.requestJira) {
    return overrides.requestJira;
  }
  forgeRequestJiraPromise ??= (async () => {
    const forgeApi = await import('@forge/api');
    const api = forgeApi.default;
    // jira.js encodes every dynamic part; route`${path}` would escape the
    // slashes and Forge rejects it as path manipulation.
    const { assumeTrustedRoute } = forgeApi;
    return (path, init) =>
      api.asApp().requestJira(assumeTrustedRoute(path), init);
  })();
  return forgeRequestJiraPromise;
}

/**
 * @returns {object|null}
 */
function configuredLogger() {
  return overrides.logger;
}

/**
 * The default consumer instance. Reused so duplicate deliveries for one warm
 * function instance share the same per-key lock.
 *
 * @returns {Function}
 */
function getDefaultApplier() {
  defaultApplier ??= createEffectApplier({
    getStore: configuredStore,
    getQueue: configuredQueue,
    getRequestJira: configuredRequestJira,
    logger: configuredLogger(),
    now: () => (typeof overrides.now === 'function' ? overrides.now() : Date.now()),
    // Live read. The simulator sets `env` once in `configureEffects`. A
    // closed fault-injection gate leaves `requestJira` untouched.
    getEnv: () => overrides.env ?? process.env,
  });
  return defaultApplier;
}

/**
 * Install test/application dependency overrides.
 *
 * Any omitted key is left unchanged. Setting an explicit `null` clears a
 * previous override for `store`, `queue`, `requestJira`, or `now` (the
 * simulator clock). `logger: null` disables logging.
 *
 * @param {{
 *   store?: any,
 *   queue?: object|Function,
 *   requestJira?: Function,
 *   logger?: object|null,
 *   now?: (() => number)|null,
 *   env?: Record<string, string|undefined>|null,
 * }} [config]
 * @returns {void}
 */
export function configureEffects(config = {}) {
  if (!config || typeof config !== 'object') {
    throw new EffectValidationError('configureEffects expects an object');
  }
  if (Object.hasOwn(config, 'store')) {
    overrides.store = config.store ?? null;
  }
  if (Object.hasOwn(config, 'queue')) {
    overrides.queue = config.queue ?? null;
  }
  if (Object.hasOwn(config, 'requestJira')) {
    overrides.requestJira = config.requestJira ?? null;
  }
  if (Object.hasOwn(config, 'logger')) {
    overrides.logger = config.logger ?? null;
  }
  if (Object.hasOwn(config, 'now')) {
    overrides.now = config.now ?? null;
  }
  if (Object.hasOwn(config, 'env')) {
    overrides.env = config.env && typeof config.env === 'object' ? config.env : null;
  }
  // Rebuild so a changed logger (or a future cached dependency) takes effect.
  defaultApplier = null;
}

/**
 * Clear every injected dependency and go back to Forge adapters.
 *
 * @returns {void}
 */
export function resetEffectDependencies() {
  overrides = {
    store: null,
    queue: null,
    requestJira: null,
    logger: console,
    env: null,
    // The simulator clock is a function closed over one world's `clock.now`.
    // Drop it with the other overrides so the next world cannot apply an
    // effect against the previous world's time.
    now: null,
  };
  // A leftover fault must not ride into the next test that happens to set
  // the simulator flag. The chaos module holds the schedule in memory.
  resetFaultInjection();
  // A dedupe tally is process memory, like the fault schedule. The next
  // scenario must not inherit the previous run's drops.
  resetEffectMetrics();
  forgeQueue = null;
  forgeRequestJiraPromise = null;
  defaultApplier = null;
}

/**
 * Names of effect dependencies a previous test left installed.
 * An empty list means the next caller gets the Forge defaults, not the
 * previous scenario's store, queue, Jira client, or clock.
 * The simulator checks this between scenarios.
 *
 * @returns {string[]}
 */
export function leftoverEffectDependencies() {
  /** @type {string[]} */
  const leftover = [];
  if (overrides.store) leftover.push('store');
  if (overrides.queue) leftover.push('queue');
  if (overrides.requestJira) leftover.push('requestJira');
  if (overrides.env) leftover.push('env');
  if (typeof overrides.now === 'function') leftover.push('clock');
  if (forgeQueue) leftover.push('forgeQueue');
  if (forgeRequestJiraPromise) leftover.push('requestJiraPromise');
  if (defaultApplier) leftover.push('applier');
  if (hasPendingEffectMetrics()) leftover.push('effectMetrics');
  return leftover;
}

/**
 * Convenience setter used by tests that only replace the store.
 *
 * @param {any} store
 * @returns {void}
 */
export function setEffectStore(store) {
  configureEffects({ store });
}

/**
 * Convenience setter used by tests that only replace the queue.
 *
 * @param {object|Function} queue
 * @returns {void}
 */
export function setEffectQueue(queue) {
  configureEffects({ queue });
}

/**
 * Convenience setter used by tests that only replace the Jira request function.
 *
 * @param {Function} requestJira
 * @returns {void}
 */
export function setRequestJira(requestJira) {
  configureEffects({ requestJira });
}

/**
 * Persist an effect if its request key is new, and push it to `effect-queue`
 * on the first insert only.
 *
 * Duplicate enqueueing is intentionally cheap and silent: the store returns
 * `created:false`, no second queue message is emitted, and the original
 * payload wins. That is what guarantees one Jira mutation for one key.
 *
 * @param {{
 *   runId: string,
 *   stepId?: string,
 *   kind: 'createIssue'|'comment'|'transition'|'closeIssue'|'recordRemovedComment'|'restoreStatus',
 *   payload: any,
 *   discriminator?: unknown,
 * }} input
 * @param {{store?: any, queue?: object|Function}} [options] Test/DI overrides.
 * @returns {Promise<{requestKey: string, created: boolean}>}
 */
export async function enqueueEffect(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new EffectValidationError('enqueueEffect expects an object');
  }
  const kind = input.kind;
  if (typeof kind !== 'string' || !EFFECT_KINDS.includes(kind)) {
    throw new EffectValidationError(
      `kind must be one of ${EFFECT_KINDS.join(', ')}`,
    );
  }
  validateEffectPayload(kind, input.payload);

  const requestKey = requestKeyFor(input);
  const store = options.store ?? configuredStore();
  const queue = options.queue ?? configuredQueue();

  const { created } = await store.putEffectIfAbsent({
    requestKey,
    runId: input.runId,
    stepId: input.stepId,
    kind,
    payload: input.payload,
  });

  if (created) {
    // Only the insert pushes. A duplicate enqueue therefore cannot create a
    // second delivery, and an applied effect is already terminal.
    // A refused push (Forge returns 400 while a deploy rolls over) must not
    // abort the caller: the row is already `pending`, and the watchdog
    // re-pushes pending rows. Retry briefly, then log and carry on.
    let pushed = false;
    let lastError = null;
    const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    for (let tryIndex = 0; tryIndex < 3 && !pushed; tryIndex += 1) {
      try {
        await pushEffectEvent(queue, buildEffectEvent(requestKey));
        pushed = true;
      } catch (error) {
        lastError = error;
        if (tryIndex < 2) await sleep(1000 * (tryIndex + 1));
      }
    }
    if (!pushed) {
      console.error('[effects] push failed; watchdog will re-push pending row', {
        requestKey,
        error: String(lastError?.message ?? lastError),
      });
    } else {
      // Chaos duplicate. One extra queue message for the same request key,
      // and only after the first push succeeded. The store row was inserted
      // once, so the second delivery is the at-least-once case the applier
      // already dedupes. A closed gate returns null and does not push. A
      // failed extra push is logged and does not fail the original enqueue.
      const faultEnv = options.env ?? overrides.env ?? process.env;
      const duplicate = takeDuplicateEffect(requestKey, faultEnv);
      if (duplicate) {
        try {
          await pushEffectEvent(queue, buildEffectEvent(requestKey));
          // The extra message is on the queue. Count the injection now,
          // while we still know the run. The applier counts the heal when
          // it drops the second delivery. A failed counter write does not
          // fail the original enqueue.
          await safeChaos(null, () => recordFaultInjected(store, {
            runId: input.runId,
            requestKey,
            kind: 'duplicate-effect',
          }, faultEnv));
        } catch (error) {
          console.error('[fault-injection] duplicate effect push failed', {
            requestKey,
            error: String(error?.message ?? error),
          });
        }
      }
    }
    // Journal the effect under its requestKey as soon as the row exists.
    // Replay looks this key up and will not write it to Jira again once the
    // applier has recorded phase `applied`.
    if (typeof input.runId === 'string' && input.runId.length > 0) {
      let stepIdx;
      if (typeof input.stepId === 'string' && input.stepId.length > 0 && typeof store.getStep === 'function') {
        const owner = await store.getStep(input.stepId);
        if (Number.isInteger(owner?.idx)) {
          stepIdx = owner.idx;
        }
      }
      await recordEvent(store, {
        runId: input.runId,
        kind: 'effect.written',
        stepId: typeof input.stepId === 'string' ? input.stepId : undefined,
        stepIdx,
        journalKey: requestKey,
        detail: {
          phase: 'stored',
          kind,
          requestKey,
          status: 'pending',
        },
      });
    }
    return { requestKey, created, pushed };
  }

  // The row already existed. No second push and no KVS write. The drop is
  // a dedupe. It stays in process memory until a budget write that is
  // already happening can store it.
  noteEffectDeduped(input.runId);
  return { requestKey, created };
}

/**
 * Enqueue one undo plan on the existing `effect-queue`.
 *
 * Each descriptor comes from `planCompensations`. The discriminator is
 * `undo:<forwardKind>:<forwardRequestKey>`, so a second Undo hashes to the
 * same key and `putEffectIfAbsent` returns `created: false`. No second
 * queue message is pushed. `dependsOnKeys` is copied onto the payload
 * because the effect entity has no other place to put it. The applier
 * waits on those keys and does not send them to Jira.
 *
 * @param {{compensations?: Array<object>}} plan
 * @param {{store?: any, queue?: object|Function, sleep?: Function}} [options]
 * @returns {Promise<Array<{requestKey: string, created: boolean, pushed?: boolean}>>}
 */
export async function enqueueCompensations(plan, options = {}) {
  const items = Array.isArray(plan?.compensations) ? plan.compensations : [];
  /** @type {Array<{requestKey: string, created: boolean, pushed?: boolean}>} */
  const results = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      throw new EffectValidationError('compensation descriptor must be an object');
    }
    /** @type {Record<string, unknown>} */
    const payload = item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
      ? { ...item.payload }
      : {};
    if (Array.isArray(item.dependsOnKeys) && item.dependsOnKeys.length > 0) {
      payload.dependsOnKeys = item.dependsOnKeys;
    }
    const stepId = typeof item.stepId === 'string' && item.stepId.length > 0
      ? item.stepId
      : undefined;
    const queued = await enqueueEffect({
      runId: item.runId,
      stepId,
      kind: item.kind,
      payload,
      discriminator: item.discriminator,
    }, options);
    results.push(queued);
  }
  return results;
}

/**
 * Consumer for `effect-queue`.
 *
 * Forge invokes this with `event.body.requestKey`. The handler re-reads the
 * effect, skips terminal records, applies the mutation, persists the result,
 * and schedules bounded retries. It resolves after the effect reaches a
 * terminal state or is scheduled for another attempt.
 *
 * Optional `options` inject dependencies for tests. When omitted, the shared
 * default applier (and its in-process locks) is used.
 *
 * @param {{body?: {requestKey?: string}, requestKey?: string}} event
 * @param {{
 *   store?: any,
 *   getStore?: () => any,
 *   requestJira?: Function,
 *   getRequestJira?: () => Function|Promise<Function>,
 *   queue?: object|Function,
 *   getQueue?: () => object|Function|Promise<object|Function>,
 *   logger?: object|null,
 * }} [options]
 * @returns {Promise<import('../store/types.js').Effect|null>}
 */
export function effectApplierHandler(event, options) {
  if (!options) {
    return getDefaultApplier()(event);
  }

  /** @type {Record<string, any>} */
  const deps = { ...options };
  if (!Object.hasOwn(deps, 'store') && !Object.hasOwn(deps, 'getStore')) {
    deps.getStore = configuredStore;
  }
  if (
    !Object.hasOwn(deps, 'requestJira') &&
    !Object.hasOwn(deps, 'getRequestJira')
  ) {
    deps.getRequestJira = configuredRequestJira;
  }
  if (!Object.hasOwn(deps, 'queue') && !Object.hasOwn(deps, 'getQueue')) {
    deps.getQueue = configuredQueue;
  }
  if (!Object.hasOwn(deps, 'logger')) {
    deps.logger = configuredLogger();
  }
  return createEffectApplier(deps)(event);
}
