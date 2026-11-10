/**
 * Constants shared by the watchdog modules (WP4).
 *
 * The queue names and payload shapes come from docs/TASKS.md:
 * - `step-queue` events are `{runId, stepId, attempt}` (WP3).
 * - `effect-queue` events are `{requestKey}` (WP2).
 *
 * @module watchdog/constants
 */

/** Queue consumed by the WP3 step worker. @constant {string} */
export const STEP_QUEUE_NAME = 'step-queue';

/** Queue consumed by the WP2 effect applier. @constant {string} */
export const EFFECT_QUEUE_NAME = 'effect-queue';

/**
 * Highest attempt number a step may reach. Steps start at attempt 0, so the
 * watchdog retries attempts 0, 1, and 2, then fails the step at attempt 3.
 * This is the `attempt >= 3` rule in docs/DESIGN.md §2.5.
 *
 * @constant {number}
 */
export const MAX_STEP_ATTEMPTS = 3;

/**
 * A step starts with a 12-minute deadline in WP3. The watchdog writes the same
 * window when it re-queues a stuck step, so one retry cannot be picked up
 * again until its new deadline expires.
 *
 * @constant {number}
 */
export const RETRY_DEADLINE_MS = 12 * 60 * 1000;

/**
 * Effects left in `pending` or `retrying` for longer than five minutes are
 * re-pushed to `effect-queue`.
 *
 * @constant {number}
 */
export const STALE_EFFECT_MS = 5 * 60 * 1000;

/**
 * Maximum number of steps or effects handled at once. Forge allows 1,000
 * storage requests per second per installation, so a small fan-out keeps a
 * 200-step pass well inside the 25-second budget without saturating storage.
 *
 * @constant {number}
 */
export const DEFAULT_CONCURRENCY = 10;

/** Forge variable that arms the one-shot demo hang. @constant {string} */
export const DEMO_STUCK_ENV_VAR = 'CONDUCTOR_DEMO_STUCK_STEP';
