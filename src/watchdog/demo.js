/**
 * Demo-only stuck-step switch (WP4).
 *
 * The demo needs one step to hang exactly once so the watchdog has something
 * to retry. The Go/No-Go value format is owned by WP4. Forge variables are
 * strings, so:
 *
 * - unset, empty, or whitespace: the demo switch is off;
 * - `true`, `1`, `*`, or any other non-empty text: hang the first step
 *   (`idx` 0);
 * - a decimal number of 2 or more such as `2`: hang that step index instead.
 *   (`1` is treated as "on" because that is the value people type first.)
 *
 * A step only hangs while it is running on attempt 0. The watchdog retry
 * raises the attempt to 1, so the same step completes on the second run.
 * WP3's step worker should call {@link shouldDemoHang} after it marks a step
 * running and before it does any work. It can call {@link demoHangDelayMs} to
 * sleep past `deadlineAt`; the watchdog then retries the step.
 *
 * @module watchdog/demo
 */

import { DEMO_STUCK_ENV_VAR, RETRY_DEADLINE_MS } from './constants.js';

/**
 * Read and trim the configured demo value.
 *
 * @param {Record<string, string|undefined>} [env] Environment-like object.
 * @returns {string} Trimmed value, or `''` when the switch is off.
 */
export function getDemoStuckValue(env = process.env) {
  const raw = env?.[DEMO_STUCK_ENV_VAR];
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Whether the demo switch is armed.
 *
 * @param {Record<string, string|undefined>} [env] Environment-like object.
 * @returns {boolean}
 */
export function isDemoStuckEnabled(env = process.env) {
  return getDemoStuckValue(env).length > 0;
}

/**
 * Resolve which step index should hang. A decimal value of 2 or more selects
 * that index; `1`, `true`, `*`, and any other non-empty text select step 0.
 * This keeps the documented "any non-empty value hangs one step" behaviour
 * while letting the demo pick a different step for a different recording.
 *
 * @param {Record<string, string|undefined>} [env] Environment-like object.
 * @returns {number|null} Zero-based step index, or `null` when disabled.
 */
export function demoStuckStepIdx(env = process.env) {
  const value = getDemoStuckValue(env);
  if (!value) {
    return null;
  }
  if (/^\d+$/.test(value) && Number(value) >= 2) {
    return Number(value);
  }
  return 0;
}

/**
 * True when this running step is the one the demo should hang. Because the
 * check requires `attempt === 0` and the watchdog advances `attempt` when it
 * retries, the hang happens once per run.
 *
 * @param {import('../store/types.js').Step|null|undefined} step Running step.
 * @param {Record<string, string|undefined>} [env] Environment-like object.
 * @returns {boolean}
 */
export function shouldDemoHang(step, env = process.env) {
  if (!step || step.status !== 'running' || step.attempt !== 0) {
    return false;
  }
  return step.idx === demoStuckStepIdx(env);
}

/**
 * How long a demo-hung worker should sleep before returning without reporting
 * a result. The watchdog only sees a running step after `deadlineAt`, so sleep
 * to that point plus a one-second guard.
 *
 * WP3 integration: call this after marking the step running, await the delay,
 * then return without calling `reportStep`. Leave the step `running` so the
 * watchdog can retry it.
 *
 * @param {import('../store/types.js').Step} step Running step.
 * @param {{env?: Record<string, string|undefined>, now?: number}} [options]
 * @returns {number} Milliseconds to sleep; `0` when this step should not hang.
 */
export function demoHangDelayMs(step, options = {}) {
  const env = options.env ?? process.env;
  if (!shouldDemoHang(step, env)) {
    return 0;
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const deadlineAt = Number.isFinite(step.deadlineAt)
    ? step.deadlineAt
    : now + RETRY_DEADLINE_MS;
  return Math.max(0, deadlineAt - now) + 1000;
}
