/**
 * Bounded retry for `@forge/events` Queue.push.
 *
 * On dev, the first pushes after a deploy came back `400 Bad Request`
 * (InternalServerError, no errorCode) while later pushes with the same tiny
 * body succeeded. A dropped step push leaves the step `queued` until the
 * watchdog's deadline, which is why "normal" runs needed a watchdog retry.
 * Our bodies are a few ids, far under the 100 KB limit, so a 400/429/5xx
 * here is treated as transient for a few seconds.
 */
export const QUEUE_PUSH_BACKOFF_MS = Object.freeze([500, 1500, 4000]);

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTransientQueuePushError(error) {
  const e = /** @type {any} */ (error);
  const status = e?.status ?? e?.responseDetails?.status
    ?? Number(/^(\d{3})\b/.exec(String(e?.message ?? ''))?.[1]);
  return status === 400 || status === 429 || (status >= 500 && status < 600);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @template T
 * @param {() => Promise<T>} push
 * @param {{sleep?: (ms: number) => Promise<void>, label?: string}} [options]
 * @returns {Promise<T>}
 */
export async function pushWithRetry(push, options = {}) {
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await push();
    } catch (error) {
      if (attempt >= QUEUE_PUSH_BACKOFF_MS.length || !isTransientQueuePushError(error)) {
        throw error;
      }
      console.warn(`[queue] transient push error on ${options.label ?? 'queue'}; retry ${attempt + 1}`);
      await sleep(QUEUE_PUSH_BACKOFF_MS[attempt]);
    }
  }
}
