/**
 * Public WP4 watchdog entry point.
 *
 * The Forge scheduled trigger calls {@link watchdogHandler}. Tests and WP9 can
 * call {@link createWatchdogHandler} with a memory store and recorder queue
 * functions, or use {@link createWatchdog} directly for one pass.
 *
 * @module watchdog
 */

import { getStore } from '../store/index.js';
import {
  EFFECT_QUEUE_NAME,
  STEP_QUEUE_NAME,
} from './constants.js';
import { createForgeQueuePusher } from './queues.js';
import { createWatchdog } from './watchdog.js';
import { shouldScan } from './gate.js';

export {
  DEFAULT_CONCURRENCY,
  DEMO_STUCK_ENV_VAR,
  EFFECT_QUEUE_NAME,
  MAX_STEP_ATTEMPTS,
  RETRY_DEADLINE_MS,
  STALE_EFFECT_MS,
  STEP_QUEUE_NAME,
} from './constants.js';
export {
  demoHangDelayMs,
  demoStuckStepIdx,
  getDemoStuckValue,
  isDemoStuckEnabled,
  shouldDemoHang,
} from './demo.js';
export { requestKeyFor } from './requestKey.js';
export { createForgeQueuePusher } from './queues.js';
export {
  createStoreEffectEnqueuer,
  createWatchdog,
  effectRequestKeyFor,
} from './watchdog.js';

/**
 * Build a scheduled-trigger handler around explicit dependencies. WP9 uses the
 * default {@link watchdogHandler}; tests use this factory to avoid Forge.
 *
 * @param {import('./watchdog.js').WatchdogDependencies} dependencies
 * @returns {() => Promise<import('./watchdog.js').WatchdogSummary>}
 */
export function createWatchdogHandler(dependencies) {
  const watchdog = createWatchdog(dependencies);
  return async function runWatchdog() {
    return watchdog.run();
  };
}

/**
 * Forge `scheduledTrigger` handler for the `watchdog` module (fiveMinute).
 *
 * The pass is idempotent enough for at-least-once scheduling:
 * - completed steps are skipped by a fresh `getStep` check;
 * - a retry sets a new 12-minute deadline before pushing, so an overlapping
 *   pass does not advance the same attempt;
 * - the Epic failure comment is keyed by
 *   `sha256(runId|stepId|comment|watchdog-blocked)` and deduped by WP1/WP2.
 *
 * @returns {Promise<import('./watchdog.js').WatchdogSummary>}
 */
export async function watchdogHandler(event, context) {
  // The app is installed on the site for Jira and for Confluence, and Forge
  // fires the scheduled trigger once per installation: that is why the logs
  // show a pass every ~2.5 minutes. Runs live only in the Jira installation,
  // so the Confluence pass stops here with zero KVS reads.
  const installContext = String(context?.installContext ?? event?.context?.installContext ?? '');
  if (installContext.includes(':confluence:')) {
    return { skipped: 'confluence-install' };
  }
  // Off-tick passes cost zero KVS reads; idle passes cost one small read.
  const gate = await shouldScan();
  if (!gate.scan) {
    console.log(`[watchdog] skipped=${gate.reason}`);
    return { skipped: gate.reason };
  }
  const store = getStore();
  const watchdog = createWatchdog({
    store,
    pushStep: createForgeQueuePusher(STEP_QUEUE_NAME),
    pushEffect: createForgeQueuePusher(EFFECT_QUEUE_NAME),
  });
  return watchdog.run();
}
