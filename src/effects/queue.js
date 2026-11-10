/**
 * Queue wiring for the effects queue (WP2).
 *
 * The queue message is intentionally tiny: `{ body: { requestKey } }`. The
 * effect itself lives in the entity store, so a message can be redelivered or
 * re-pushed by the watchdog without carrying stale payload data.
 *
 * `@forge/events` is imported lazily by `createForgeQueue()`, which means unit
 * tests never need the package installed. Tests inject any object with a
 * `push(event)` method (or a plain push function).
 *
 * @module effects/queue
 */

import { EffectValidationError } from './errors.js';
import { pushWithRetry } from '../platform/queuePushRetry.js';

/** Queue declared in the WP9 manifest for Jira mutations. @constant */
export const EFFECT_QUEUE_NAME = 'effect-queue';

/**
 * Since `@forge/events` 2.x the pushed value must be `{ body: ... }`; a bare
 * object throws "Event body must be an object". The consumer reads
 * `event.body.requestKey`.
 *
 * `delayInSeconds` is a top-level property of the pushed event and is a
 * platform-level backoff hint (0–900 seconds).
 *
 * @param {string} requestKey
 * @param {number} [delayInSeconds]
 * @returns {{body: {requestKey: string}, delayInSeconds?: number}}
 */
export function buildEffectEvent(requestKey, delayInSeconds) {
  /** @type {{body: {requestKey: string}, delayInSeconds?: number}} */
  const event = { body: { requestKey } };
  if (delayInSeconds !== undefined) {
    event.delayInSeconds = delayInSeconds;
  }
  return event;
}

/**
 * Push one effect event through an injected queue.
 *
 * @param {{push: Function}|Function} queue Forge `Queue` instance or test fake.
 * @param {{body: {requestKey: string}, delayInSeconds?: number}} event
 * @returns {Promise<unknown>}
 */
export async function pushEffectEvent(queue, event) {
  if (typeof queue === 'function') {
    return queue(event);
  }
  if (queue && typeof queue.push === 'function') {
    return queue.push(event);
  }
  throw new EffectValidationError(
    'effect queue must be a push function or an object with push(event)',
  );
}

/**
 * Create a lazy Forge queue adapter for `effect-queue`.
 *
 * The SDK loader is injectable so tests (or a future alternative platform)
 * can provide a fake `Queue` class. Production calls this with no options and
 * loads `@forge/events` on the first push.
 *
 * @param {{sdkLoader?: () => Promise<{Queue: new (options: {key: string}) => object}>}} [options]
 * @returns {{push: (event: object) => Promise<unknown>}}
 */
export function createForgeQueue(options = {}) {
  /** @type {Promise<{Queue: new (options: {key: string}) => object}>|null} */
  let sdkPromise = null;

  /**
   * @returns {Promise<{Queue: new (options: {key: string}) => object}>}
   */
  async function getSdk() {
    if (options.sdkLoader) {
      sdkPromise ??= options.sdkLoader();
    } else {
      sdkPromise ??= /** @type {Promise<{Queue: new (options: {key: string}) => object}>} */ (
        import('@forge/events')
      );
    }
    return sdkPromise;
  }

  /** @type {object|null} */
  let queue = null;

  return {
    /**
     * @param {object} event
     * @returns {Promise<unknown>}
     */
    async push(event) {
      if (!queue) {
        const sdk = await getSdk();
        queue = new sdk.Queue({ key: EFFECT_QUEUE_NAME });
      }
      const q = /** @type {{push: (event: object) => Promise<unknown>}} */ (queue);
      return pushWithRetry(() => q.push(event), { label: EFFECT_QUEUE_NAME });
    },
  };
}
