/**
 * Tiny in-process async lock used by WP3 (and available to WP4).
 *
 * The Forge store gives WP1 optimistic updates for runs, but step records are
 * plain entity rows and have no compare-and-set helper. At-least-once queue
 * delivery can therefore start two copies of the same worker in one function
 * instance. Serialising work per run and per step inside the process avoids
 * most duplicate side effects; the attempt checks in `stepWorkerHandler` remain
 * the authoritative guard across instances.
 *
 * This is intentionally not a distributed lock. Forge may run several function
 * instances concurrently, so the state machine still tolerates duplicate work
 * by using deterministic effect request keys (WP2) and terminal-step checks.
 *
 * @module run/locks
 */

/**
 * Tail promise for each key. A new task chains after the previous task for the
 * same key, while different keys run independently.
 *
 * @type {Map<string, Promise<unknown>>}
 */
const tails = new Map();

/**
 * Run `task` after all previously queued tasks with the same key have settled.
 *
 * A rejected task does not poison the chain: the tail is always a promise that
 * resolves, and the original rejection is returned to its caller.
 *
 * @template T
 * @param {string} key Lock key, e.g. `run:<runId>` or `step:<stepId>`.
 * @param {() => Promise<T>} task Work to serialise.
 * @returns {Promise<T>}
 */
export function withLock(key, task) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('withLock key must be a non-empty string');
  }
  if (typeof task !== 'function') {
    throw new TypeError('withLock task must be a function');
  }

  const previous = tails.get(key) ?? Promise.resolve();
  // Swallow the previous task's rejection before starting this one so callers
  // that do not await every task still make progress.
  const result = previous.catch(() => {}).then(task);
  const tail = result.catch(() => {});
  tails.set(key, tail);

  return result.finally(() => {
    // Only delete when this task is still the newest one for the key.
    if (tails.get(key) === tail) {
      tails.delete(key);
    }
  });
}

/**
 * Drop all in-process locks. Tests call this between scenarios so one test
 * cannot inherit another test's queue.
 *
 * @returns {void}
 */
export function resetLocks() {
  tails.clear();
}

/**
 * How many lock keys still have a tail. The simulator expects 0 between
 * scenarios. A non-zero count means a previous run is still queued on a
 * shared key such as `run:<runId>`, and the next scenario would wait on it.
 *
 * @returns {number}
 */
export function pendingLockCount() {
  return tails.size;
}
