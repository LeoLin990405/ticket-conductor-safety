/**
 * Public WP1 storage interface (docs/TASKS.md).
 *
 * Production code can import the named functions directly:
 *
 * ```js
 * import { createRun, getRun, updateRun } from '../store/index.js';
 * ```
 *
 * Those functions use one lazily-created Forge Custom Entity Store instance.
 * Tests and local scenarios can replace it with an in-memory store:
 *
 * ```js
 * import { setStore, createMemoryStore } from '../store/index.js';
 * setStore(createMemoryStore());
 * ```
 *
 * The factory forms are also exported so a caller can hold an explicit store
 * instead of using the module singleton.
 *
 * @module store
 */

import { createForgeStore } from './forgeAdapter.js';
import {
  createMemoryAdapter,
  createMemoryStore,
  MEMORY_INDEX_DEFINITIONS,
} from './memoryAdapter.js';

export {
  ConflictError,
  NotFoundError,
  StoreError,
  StoreValidationError,
  ValueTooLargeError,
} from './errors.js';
export {
  EFFECT_KINDS,
  EFFECT_STATUSES,
  MAX_VALUE_BYTES,
  MAX_VALUE_LABEL,
  MEMORY_SCOPES,
  MEMORY_TYPES,
  EVENT_KINDS,
  RUN_STATUSES,
  STEP_STATUSES,
  STUCK_QUEUED_MS,
} from './types.js';
export { createForgeStore } from './forgeAdapter.js';
export {
  createMemoryAdapter,
  createMemoryStore,
  MEMORY_INDEX_DEFINITIONS,
} from './memoryAdapter.js';

/** @type {import('./types.js').Store|null} */
let activeStore = null;
let activeIsForge = false;

/** Methods every store object must provide. @constant */
const REQUIRED_METHODS = Object.freeze([
  'createRun',
  'getRun',
  'listRunsByEpic',
  'updateRun',
  'createSteps',
  'getStep',
  'listSteps',
  'updateStep',
  'findStuckSteps',
  'putEffectIfAbsent',
  'getEffect',
  'updateEffect',
  'listEffectsByStatus',
  'listEffectsByRun',
  'getStepByChildIssueKey',
  'addMemory',
  'listMemoriesByProject',
  'supersedeMemory',
  'appendEvent',
  'listEventsByRun',
  'listEventsByJournalKey',
]);

/**
 * Return the current store, creating the Forge-backed singleton on first use.
 * Creating the Forge store does not import `@forge/kvs`; that happens on the
 * first storage call, so importing this module is side-effect free.
 *
 * @returns {import('./types.js').Store}
 */
export function getStore() {
  if (!activeStore) {
    activeStore = createForgeStore();
    activeIsForge = true;
  }
  return activeStore;
}

/**
 * Replace the module-level store. Tests use this to install
 * `createMemoryStore()`. The object is validated so a typo cannot silently
 * break every handler at runtime.
 *
 * @param {import('./types.js').Store} store
 * @returns {import('./types.js').Store} The installed store.
 */
export function setStore(store) {
  if (!store || typeof store !== 'object') {
    throw new TypeError('setStore expects a store object');
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof store[method] !== 'function') {
      throw new TypeError(`setStore: store.${method} must be a function`);
    }
  }
  activeStore = store;
  activeIsForge = false;
  return activeStore;
}

/**
 * Drop the module-level store so the next call creates a Forge store again.
 * Mainly useful between tests.
 *
 * @returns {void}
 */
export function resetStore() {
  activeStore = null;
  activeIsForge = false;
}

/**
 * True when a store is installed, either by `setStore` or by a lazy
 * `getStore`. The simulator checks this between scenarios so one world's
 * rows cannot be read by the next world. Production code does not call it.
 *
 * @returns {boolean}
 */
export function storeIsInstalled() {
  return activeStore !== null;
}

/**
 * @param {import('./types.js').CreateRunInput} input
 * @returns {Promise<import('./types.js').Run>}
 */
export async function createRun(input) {
  const run = await getStore().createRun(input);
  if (activeIsForge) {
    const { markActive } = await import('../watchdog/gate.js');
    await markActive();
  }
  return run;
}

/**
 * @param {string} runId
 * @returns {Promise<import('./types.js').Run|null>}
 */
export function getRun(runId) {
  return getStore().getRun(runId);
}

/**
 * @param {string} epicKey
 * @param {import('./types.js').ListOptions} [options]
 * @returns {Promise<import('./types.js').Run[]>}
 */
export function listRunsByEpic(epicKey, options) {
  return getStore().listRunsByEpic(epicKey, options);
}

/**
 * @param {string} runId
 * @param {Partial<import('./types.js').Run>} patch
 * @param {import('./types.js').UpdateRunOptions} [options]
 * @returns {Promise<import('./types.js').Run>}
 */
export function updateRun(runId, patch, options) {
  return getStore().updateRun(runId, patch, options);
}

/**
 * @param {string} runId
 * @param {import('./types.js').StepDraft[]} steps
 * @returns {Promise<import('./types.js').Step[]>}
 */
export function createSteps(runId, steps, options) {
  return getStore().createSteps(runId, steps, options);
}

/**
 * @param {string} stepId
 * @returns {Promise<import('./types.js').Step|null>}
 */
export function getStep(stepId) {
  return getStore().getStep(stepId);
}

/**
 * @param {string} runId
 * @returns {Promise<import('./types.js').Step[]>}
 */
export function listSteps(runId) {
  return getStore().listSteps(runId);
}

/**
 * @param {string} stepId
 * @param {Partial<import('./types.js').Step>} patch
 * @param {{expectedStatus?: import('./types.js').StepStatus}} [options]
 *   When set, the write happens only if the stored status is still this
 *   value. A mismatch returns null and leaves the row unchanged.
 * @returns {Promise<import('./types.js').Step|null>}
 */
export function updateStep(stepId, patch, options) {
  return getStore().updateStep(stepId, patch, options);
}

/**
 * @param {number} [nowMs]
 * @returns {Promise<import('./types.js').Step[]>}
 */
export function findStuckSteps(nowMs) {
  return getStore().findStuckSteps(nowMs);
}

/**
 * @param {import('./types.js').EffectInput} effect
 * @returns {Promise<import('./types.js').PutEffectResult>}
 */
export function putEffectIfAbsent(effect) {
  return getStore().putEffectIfAbsent(effect);
}

/**
 * @param {string} requestKey
 * @returns {Promise<import('./types.js').Effect|null>}
 */
export function getEffect(requestKey) {
  return getStore().getEffect(requestKey);
}

/**
 * @param {string} requestKey
 * @param {Partial<import('./types.js').Effect>} patch
 * @returns {Promise<import('./types.js').Effect>}
 */
export function updateEffect(requestKey, patch, options) {
  return getStore().updateEffect(requestKey, patch, options);
}

/**
 * Effects for one run, newest update first. The panel timeline uses this.
 *
 * @param {string} runId
 * @param {import('./types.js').ListOptions} [options]
 * @returns {Promise<import('./types.js').Effect[]>}
 */
export function listEffectsByRun(runId, options) {
  return getStore().listEffectsByRun(runId, options);
}

/**
 * Step whose `childIssueKey` is this Jira issue, if the effect applier has
 * recorded one. The child-issue trigger uses this lookup.
 *
 * @param {string} issueKey
 * @returns {Promise<import('./types.js').Step|null>}
 */
export function getStepByChildIssueKey(issueKey) {
  return getStore().getStepByChildIssueKey(issueKey);
}

/**
 * @param {import('./types.js').EffectStatus} status
 * @param {import('./types.js').ListOptions} [options]
 * @returns {Promise<import('./types.js').Effect[]>}
 */
export function listEffectsByStatus(status, options) {
  return getStore().listEffectsByStatus(status, options);
}

/**
 * @param {import('./types.js').MemoryInput} memory
 * @returns {Promise<import('./types.js').Memory>}
 */
export function addMemory(memory) {
  return getStore().addMemory(memory);
}

/**
 * @param {string} projectKey
 * @param {import('./types.js').ListOptions} [options]
 * @returns {Promise<import('./types.js').Memory[]>}
 */
export function listMemoriesByProject(projectKey, options) {
  return getStore().listMemoriesByProject(projectKey, options);
}

/**
 * @param {string} memId
 * @param {string} byMemId
 * @returns {Promise<import('./types.js').Memory>}
 */
export function supersedeMemory(memId, byMemId) {
  return getStore().supersedeMemory(memId, byMemId);
}

/**
 * Append one flight-recorder event. The store assigns `seq`. The key is not
 * written back as an attribute.
 *
 * @param {import('./types.js').EventInput} input
 * @returns {Promise<import('./types.js').FlightEvent>}
 */
export function appendEvent(input) {
  return getStore().appendEvent(input);
}

/**
 * @param {string} runId
 * @param {import('./types.js').ListOptions} [options]
 * @returns {Promise<import('./types.js').FlightEvent[]>}
 */
export function listEventsByRun(runId, options) {
  return getStore().listEventsByRun(runId, options);
}

/**
 * Journal lookup. `journalKey` is an effect requestKey or a step-result key.
 *
 * @param {string} journalKey
 * @param {import('./types.js').ListOptions} [options]
 * @returns {Promise<import('./types.js').FlightEvent[]>}
 */
export function listEventsByJournalKey(journalKey, options) {
  return getStore().listEventsByJournalKey(journalKey, options);
}
