/**
 * Runtime dependencies shared by the run state machine and the step workers
 * (WP3).
 *
 * WP3 depends on three things that live outside its own directories:
 *
 * 1. the WP1 store (`src/store/`) for run/step records;
 * 2. the WP2 effects queue (`src/effects/`) through its documented
 *    `enqueueEffect(input)` function;
 * 3. the `step-queue` event queue, normally `@forge/events`.
 *
 * Every public WP3 function therefore accepts an optional dependency object as
 * its last argument. Production callers can call `startRun(runId)` and get the
 * lazy Forge-backed defaults below; unit tests pass a memory store and a fake
 * `enqueueEffect`, so `node --test` runs with no extra packages installed.
 *
 * The production defaults are deliberately lazy:
 * - `src/effects/` may not be merged into the current branch yet, so importing
 *   it at module load would break WP3 tests. The dynamic `import()` happens
 *   only when an effect is actually enqueued.
 * - `@forge/events` and `@forge/api` are Forge runtime modules. Tests never
 *   reach the dynamic imports because they inject a queue and a Jira client.
 *
 * @module run/dependencies
 */

import * as storeNamespace from '../store/index.js';
import { pushWithRetry } from '../platform/queuePushRetry.js';

/**
 * Name of the async event queue consumed by `stepWorkerHandler`.
 * @constant {string}
 */
export const STEP_QUEUE_NAME = 'step-queue';

/**
 * How long a step is allowed to run before the WP4 watchdog may retry it.
 * The consumer timeout is 900 s; 12 minutes leaves a small safety margin.
 * @constant {number}
 */
export const STEP_DEADLINE_MS = 12 * 60 * 1000;

/**
 * Minimal Jira client used by the built-in workers.
 *
 * `searchIssues(jql, {limit})` resolves to an array of
 * `{key, summary, status, issueType}` objects. `getIssueLinks(issueKey)`
 * resolves to an array of `{key, summary, status, type, direction}` objects.
 *
 * The lazy proxy keeps `@forge/api` out of the unit-test import graph.
 * Production code loads `./forgeJiraClient.js` on the first call.
 *
 * @type {{searchIssues: (jql: string, options?: {limit?: number}) => Promise<Array<object>>, getIssueLinks: (issueKey: string) => Promise<Array<object>>}}
 */
export const defaultJiraClient = Object.freeze({
  async searchIssues(jql, options) {
    const { getForgeJiraClient } = await import('./forgeJiraClient.js');
    const client = await getForgeJiraClient();
    return client.searchIssues(jql, options);
  },
  async getIssueLinks(issueKey) {
    const { getForgeJiraClient } = await import('./forgeJiraClient.js');
    const client = await getForgeJiraClient();
    return client.getIssueLinks(issueKey);
  },
});

/**
 * Push one `{runId, stepId, attempt}` event to `step-queue`.
 *
 * The spike (docs/SPIKES.md) established that `@forge/events` 2+ expects
 * `queue.push({ body })`; a bare object throws. Only the three identifiers are
 * sent, keeping the event well below the 100 KB single-event limit.
 *
 * @param {{runId: string, stepId: string, attempt: number}} payload
 * @returns {Promise<{jobId?: string}>}
 */
async function defaultEnqueueStep(payload) {
  const { Queue } = await import('@forge/events');
  const queue = new Queue({ key: STEP_QUEUE_NAME });
  return pushWithRetry(() => queue.push({ body: payload }), { label: STEP_QUEUE_NAME });
}

/**
 * Call the WP2 effects API.
 *
 * `enqueueEffect` both stores the effect (deduplicated by request key) and
 * pushes `{requestKey}` to `effect-queue`. WP3 never writes Jira directly.
 *
 * @param {object} input See the WP2 interface in docs/TASKS.md.
 * @returns {Promise<{requestKey: string, created: boolean}>}
 */
async function defaultEnqueueEffect(input) {
  let effectsModule;
  try {
    effectsModule = await import('../effects/index.js');
  } catch (cause) {
    const message =
      'WP3 could not load the WP2 effects module at src/effects/index.js. ' +
      'Inject enqueueEffect in tests, or merge WP2 before deploying.';
    throw new Error(message, { cause });
  }
  if (typeof effectsModule.enqueueEffect !== 'function') {
    throw new Error(
      'src/effects/index.js must export enqueueEffect(input) as documented in docs/TASKS.md',
    );
  }
  return effectsModule.enqueueEffect(input);
}

/**
 * @typedef {object} Wp3Dependencies
 * @property {import('../store/types.js').Store} store WP1 store.
 * @property {(input: object) => Promise<{requestKey: string, created: boolean}>} enqueueEffect WP2 effects entry point.
 * @property {(payload: {runId: string, stepId: string, attempt: number}) => Promise<unknown>} enqueueStep Pushes one step event.
 * @property {{searchIssues: Function, getIssueLinks: Function}} jira Read-only Jira client used by built-in workers.
 * @property {() => number} now Clock returning epoch ms.
 * @property {{info: Function, warn: Function, error: Function}} logger Forge-compatible logger.
 */

/**
 * Merge explicit dependencies with the production defaults.
 *
 * Tests normally pass `{store, enqueueEffect, enqueueStep, jira, now}`. Any
 * omitted field falls back to the lazy production implementation, which keeps
 * the documented production signature (`startRun(runId)`) working.
 *
 * @param {Partial<Wp3Dependencies>} [overrides]
 * @returns {Wp3Dependencies}
 */
const forgeAwaitIndex = {
  async get(epicKey) {
    try {
      const { kvs } = await import('@forge/kvs');
      const value = await kvs.get(`tc-await:${epicKey}`);
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  },
  async set(epicKey, runId) {
    try {
      const { kvs } = await import('@forge/kvs');
      await kvs.set(`tc-await:${epicKey}`, runId);
    } catch {
      // Best effort: without the key a reply is ignored, never doubled.
    }
  },
};

export function resolveDependencies(overrides = {}) {
  const dependencies = {
    store: overrides.store ?? storeNamespace,
    enqueueEffect: overrides.enqueueEffect ?? defaultEnqueueEffect,
    enqueueStep: overrides.enqueueStep ?? defaultEnqueueStep,
    jira: overrides.jira ?? defaultJiraClient,
    now: overrides.now ?? (() => Date.now()),
    logger: overrides.logger ?? console,
    sleep:
      overrides.sleep ??
      ((ms) => new Promise((resolve) => {
        setTimeout(resolve, ms);
      })),
    env: overrides.env ?? process.env,
    // Optional Forge LLM client (`{chat, list}`). Absent in unit tests, so
    // the lead uses its deterministic rules. `allowLeadLlm: false` is the
    // issue trigger: that invocation is too short for a model call.
    llm: overrides.llm,
    allowLeadLlm: overrides.allowLeadLlm !== false,
    // Re-opens the watchdog gate when a paused run resumes. Production only:
    // a test that injects its own store gets no KVS write.
    // Epic -> paused runId, one plain KVS key per Epic. Production only.
    awaitIndex: overrides.awaitIndex ?? (overrides.store ? undefined : forgeAwaitIndex),
    markActive: overrides.markActive ?? (overrides.store
      ? undefined
      : async () => (await import('../watchdog/gate.js')).markActive()),
  };

  if (!dependencies.store || typeof dependencies.store !== 'object') {
    throw new TypeError('WP3 dependencies.store must be a store object');
  }
  if (typeof dependencies.enqueueEffect !== 'function') {
    throw new TypeError('WP3 dependencies.enqueueEffect must be a function');
  }
  if (typeof dependencies.enqueueStep !== 'function') {
    throw new TypeError('WP3 dependencies.enqueueStep must be a function');
  }
  if (!dependencies.jira || typeof dependencies.jira !== 'object') {
    throw new TypeError('WP3 dependencies.jira must be an object');
  }
  if (typeof dependencies.now !== 'function') {
    throw new TypeError('WP3 dependencies.now must be a function');
  }
  if (!dependencies.logger || typeof dependencies.logger !== 'object') {
    throw new TypeError('WP3 dependencies.logger must be an object');
  }

  return dependencies;
}
