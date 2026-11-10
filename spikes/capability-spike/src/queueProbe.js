import { Queue } from '@forge/events';

/**
 * Async events are the worker fallback when one Rovo agent cannot delegate
 * to another. The consumer function is allowed to run up to 900 seconds
 * when timeoutSeconds is set, but only if that function is referenced by a
 * consumer (or a scheduled trigger) and nothing else.
 * https://developer.atlassian.com/platform/forge/runtime-reference/async-events-api/
 * https://developer.atlassian.com/platform/forge/limits-invocation/
 *
 * From @forge/events 2.x onward the pushed value must be `{ body: ... }`.
 * The consumer reads `event.body`. A bare object throws
 * "Event body must be an object."
 *
 * When timeoutSeconds is above 55, each event body must stay under 100 KB.
 * https://developer.atlassian.com/platform/forge/limits-async-events/
 */

export const SPIKE_QUEUE_NAME = 'spike-queue';
const MAX_HOLD_SECONDS = 70;

const queue = new Queue({ key: SPIKE_QUEUE_NAME });

/**
 * @param {unknown} value
 * @returns {number}
 */
export function clampHoldSeconds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.min(Math.floor(parsed), MAX_HOLD_SECONDS);
}

/**
 * Push from an action or a web trigger. Both must return inside 55 seconds.
 * The push itself is the work; the consumer does the waiting.
 *
 * @param {{ holdSeconds?: number, source: string }} input
 */
export async function pushProbe(input) {
  const holdSeconds = clampHoldSeconds(input.holdSeconds);
  const result = await queue.push({
    body: {
      source: input.source,
      holdSeconds,
      enqueuedAt: Date.now(),
    },
  });
  return {
    queue: SPIKE_QUEUE_NAME,
    jobId: result.jobId,
    holdSeconds,
  };
}

/**
 * Consumer for `spike-queue`. Manifest sets timeoutSeconds: 900.
 * holdSeconds 0 proves the push arrived. holdSeconds 60 proves the
 * invocation outlived the 55-second default. It does not by itself prove
 * the platform will allow the full 900.
 *
 * @param {{ body?: { holdSeconds?: number, source?: string }, jobId?: string, queueName?: string }} event
 */
export async function queueConsumer(event) {
  const started = Date.now();
  const body = event.body || {};
  const holdSeconds = clampHoldSeconds(body.holdSeconds);

  if (holdSeconds > 0) {
    await new Promise((resolve) => {
      setTimeout(resolve, holdSeconds * 1000);
    });
  }

  // forge logs is how this probe is observed. The marker is stable.
  console.log(JSON.stringify({
    marker: 'SPIKE_QUEUE_CONSUMER_OK',
    jobId: event.jobId || null,
    queueName: event.queueName || SPIKE_QUEUE_NAME,
    source: body.source || null,
    holdSeconds,
    elapsedMs: Date.now() - started,
  }));
}
