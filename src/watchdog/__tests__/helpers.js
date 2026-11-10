/**
 * Shared test helpers for the WP4 watchdog tests.
 *
 * Nothing here touches Forge: the store is WP1's in-memory adapter and the
 * queue functions are plain recorders.
 *
 * @module watchdog/tests/helpers
 */

import { createMemoryStore } from '../../store/index.js';

/**
 * Mutable clock that can be handed to `createMemoryStore` and the watchdog.
 *
 * @param {number} [start] Initial epoch milliseconds.
 * @returns {{now: () => number, set: (value: number) => void,
 *   advance: (ms: number) => number}}
 */
export function createClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    set: (value) => {
      current = value;
    },
    advance: (ms) => {
      current += ms;
      return current;
    },
  };
}

/**
 * Record every push and optionally throw for selected payloads.
 *
 * @param {{failOn?: (payload: any) => boolean}} [options]
 * @returns {{calls: any[], push: (payload: any) => Promise<{ok: boolean}>}}
 */
export function createRecordingQueue(options = {}) {
  const calls = [];
  return {
    calls,
    async push(payload) {
      calls.push(payload);
      if (options.failOn?.(payload)) {
        throw new Error(`recording queue rejected ${JSON.stringify(payload)}`);
      }
      return { ok: true };
    },
  };
}

/**
 * A logger that keeps test output clean.
 *
 * @returns {{info: () => void, warn: () => void, error: () => void}}
 */
export function createQuietLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

/**
 * Assemble watchdog dependencies plus the recorders for assertions.
 *
 * @param {import('../../store/types.js').Store} store
 * @param {{now?: () => number,
 *   env?: Record<string, string|undefined>,
 *   enqueueEffect?: Function,
 *   stepQueue?: {calls: any[], push: Function},
 *   effectQueue?: {calls: any[], push: Function},
 *   concurrency?: number,
 *   logger?: object}} [options]
 * @returns {{deps: object, stepQueue: {calls: any[], push: Function},
 *   effectQueue: {calls: any[], push: Function}}}
 */
export function createWatchdogDeps(store, options = {}) {
  const stepQueue = options.stepQueue ?? createRecordingQueue();
  const effectQueue = options.effectQueue ?? createRecordingQueue();
  /** @type {Record<string, unknown>} */
  const deps = {
    store,
    pushStep: stepQueue.push,
    pushEffect: effectQueue.push,
    now: options.now ?? (() => Date.now()),
    env: options.env ?? {},
    logger: options.logger ?? createQuietLogger(),
  };
  if (options.enqueueEffect) {
    deps.enqueueEffect = options.enqueueEffect;
  }
  if (options.concurrency !== undefined) {
    deps.concurrency = options.concurrency;
  }
  return { deps, stepQueue, effectQueue };
}

/**
 * Create a run and its queued steps with the WP1 memory store.
 *
 * @param {import('../../store/types.js').Store} store
 * @param {{stepCount?: number, epicKey?: string, projectKey?: string,
 *   goal?: string, createdBy?: string}} [options]
 * @returns {Promise<{run: import('../../store/types.js').Run,
 *   steps: import('../../store/types.js').Step[]}>}
 */
export async function createRunWithSteps(store, options = {}) {
  const stepCount = options.stepCount ?? 1;
  const run = await store.createRun({
    epicKey: options.epicKey ?? 'PAY-100',
    projectKey: options.projectKey ?? 'PAY',
    goal: options.goal ?? 'Ship payment refunds safely',
    createdBy: options.createdBy ?? 'account-1',
  });
  const drafts = Array.from({ length: stepCount }, (_, idx) => ({
    title: `Step ${idx + 1}`,
    workerType: 'research',
    input: { idx },
  }));
  const steps = await store.createSteps(run.runId, drafts);
  return { run, steps };
}

/**
 * Make one step look like a worker that started and missed its deadline.
 *
 * @param {import('../../store/types.js').Store} store
 * @param {import('../../store/types.js').Step} step
 * @param {{now: number, attempt?: number, deadlineOffsetMs?: number}} options
 * @returns {Promise<import('../../store/types.js').Step>}
 */
export async function markRunningOverdue(store, step, options) {
  const attempt = options.attempt ?? 0;
  const deadlineOffsetMs = options.deadlineOffsetMs ?? -1;
  return store.updateStep(step.stepId, {
    status: 'running',
    attempt,
    deadlineAt: options.now + deadlineOffsetMs,
    error: undefined,
    output: undefined,
  });
}
