import { pushWithRetry } from '../platform/queuePushRetry.js';
/**
 * Lazy `@forge/events` queue pushers (WP4).
 *
 * `@forge/events` is added to the app by WP9. Importing it lazily keeps unit
 * tests and `node --test` runnable without an install, which is a requirement
 * for every package in this repo. Tests always inject recorder functions
 * instead of calling these helpers.
 *
 * @module watchdog/queues
 */

/**
 * Create a pusher for one Forge queue. The returned function accepts the event
 * body and wraps it as `{ body }`, which is required by `@forge/events` 2+.
 *
 * @param {string} queueKey Queue name from the manifest.
 * @returns {(body: Record<string, unknown>) => Promise<unknown>} Push function.
 */
export function createForgeQueuePusher(queueKey) {
  /** @type {Promise<{push: (message: {body: object}) => Promise<unknown>}>|null} */
  let queuePromise = null;

  /**
   * Load the SDK and construct the queue once. A rejected import is not
   * cached, so a later invocation can retry after the dependency is installed.
   *
   * @returns {Promise<{push: (message: {body: object}) => Promise<unknown>}>}
   */
  async function loadQueue() {
    try {
      const { Queue } = await import('@forge/events');
      return new Queue({ key: queueKey });
    } catch (error) {
      queuePromise = null;
      throw error;
    }
  }

  return async function push(body) {
    if (!queuePromise) {
      queuePromise = loadQueue();
    }
    const queue = await queuePromise;
    return pushWithRetry(() => queue.push({ body }), { label: queueKey });
  };
}
