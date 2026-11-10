/**
 * Watchdog core (WP4).
 *
 * One watchdog pass does two jobs from docs/DESIGN.md §2.5:
 *
 * 1. Read `store.findStuckSteps(now)`, then for each step either retry it
 *    (`attempt + 1`, new deadline, push to `step-queue`) or, once
 *    `attempt >= 3`, mark it `failed`, block the run, and enqueue one
 *    deterministic Epic comment effect through the WP2 interface.
 * 2. Re-push effects left in `pending` or `retrying` for more than five
 *    minutes to `effect-queue`.
 *
 * Dependency injection
 * --------------------
 * WP2 and WP3 are built in parallel and are not imported here. The factory
 * takes their documented behaviour as functions:
 *
 * - `pushStep({runId, stepId, attempt})` — WP3 `step-queue` producer.
 * - `pushEffect({requestKey})` — WP2 `effect-queue` producer.
 * - `enqueueEffect({runId, stepId, kind, payload, discriminator})` — WP2
 *   idempotent enqueue. When omitted, a small local implementation uses the
 *   same request-key formula and `store.putEffectIfAbsent`.
 *
 * WP1 is injected as `store`, so tests use `createMemoryStore()`.
 *
 * @module watchdog/watchdog
 */

import { recordKillHealed, safeChaos } from '../chaos/counters.js';
import { isFaultInjectionEnabled } from '../chaos/faults.js';
import { isApprovalGate } from '../run/approval.js';
import { recordEvent } from '../recorder/log.js';
import { buildPartialReplan, STALL_REPLAN_THRESHOLD } from '../recorder/replan.js';
import { STUCK_QUEUED_MS } from '../store/index.js';
import {
  DEFAULT_CONCURRENCY,
  MAX_STEP_ATTEMPTS,
  RETRY_DEADLINE_MS,
  STALE_EFFECT_MS,
} from './constants.js';
import { isDemoStuckEnabled } from './demo.js';
import { requestKeyFor } from './requestKey.js';

const TERMINAL_RUN_STATUSES = Object.freeze(['blocked', 'done', 'failed']);
const EFFECT_STATUSES_TO_REPUSH = Object.freeze([
  'pending',
  'retrying',
  'applying',
]);

/**
 * @typedef {object} StepQueueEvent
 * @property {string} runId
 * @property {string} stepId
 * @property {number} attempt
 */

/**
 * @typedef {object} EffectQueueEvent
 * @property {string} requestKey
 */

/**
 * @typedef {object} EnqueueEffectInput
 * @property {string} runId
 * @property {string} [stepId]
 * @property {'createIssue'|'comment'|'transition'|'closeIssue'|'recordRemovedComment'|'restoreStatus'} kind
 * @property {any} payload
 * @property {string} [discriminator]
 */

/**
 * @typedef {object} WatchdogDependencies
 * @property {import('../store/types.js').Store} store WP1 store.
 * @property {(event: StepQueueEvent) => Promise<unknown>} pushStep
 *   WP3 `step-queue` producer.
 * @property {(event: EffectQueueEvent) => Promise<unknown>} pushEffect
 *   WP2 `effect-queue` producer.
 * @property {(input: EnqueueEffectInput) => Promise<{requestKey: string,
 *   created: boolean}>} [enqueueEffect] WP2 enqueue. Optional.
 * @property {() => number} [now] Clock in epoch milliseconds.
 * @property {Record<string, string|undefined>} [env] Environment-like object.
 * @property {{info?: Function, warn?: Function, error?: Function}} [logger]
 * @property {number} [concurrency] Maximum in-flight steps or effects.
 */

/**
 * @typedef {object} WatchdogError
 * @property {'step'|'effect'|'run'} scope
 * @property {string} id
 * @property {string} name
 * @property {string} message
 * @property {string} [code]
 */

/**
 * @typedef {object} WatchdogSummary
 * @property {number} now Epoch ms used for this pass.
 * @property {boolean} demoStuck Whether `CONDUCTOR_DEMO_STUCK_STEP` is set.
 * @property {number} scannedSteps Number returned by `findStuckSteps`.
 * @property {Array<{stepId: string, runId: string, attempt: number}>} retriedSteps
 * @property {Array<{stepId: string, runId: string, attempt: number,
 *   requestKey: string|null}>} failedSteps
 * @property {Array<{stepId: string, runId: string, reason: string}>} skippedSteps
 * @property {Array<{requestKey: string}>} repushedEffects
 * @property {WatchdogError[]} errors Non-fatal problems handled this pass.
 */

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {void}
 */
function assertFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`createWatchdog: ${name} must be a function`);
  }
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function assertFiniteNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('watchdog now must be a finite epoch-millisecond number');
  }
  return value;
}

/**
 * @param {unknown} error
 * @returns {{name: string, message: string, code?: string}}
 */
function describeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
    };
  }
  return { name: 'Error', message: String(error) };
}

/**
 * Run `worker` over every item with a bounded number of promises in flight.
 * Results keep input order, which keeps tests and logs deterministic.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  /**
   * Pull the next item until the queue is empty.
   *
   * @returns {Promise<void>}
   */
  async function drain() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => drain()));
  return results;
}

/**
 * Build the deterministic request key. Kept separate so tests can assert that
 * the fallback matches WP2's documented `runId|stepId|kind|discriminator`
 * sha256 form.
 *
 * @param {EnqueueEffectInput} input
 * @returns {string}
 */
export function effectRequestKeyFor(input) {
  return requestKeyFor(input);
}

/**
 * Create a WP2-compatible enqueue function backed by the injected store and
 * effect queue. It only pushes when it created the effect, matching WP2's
 * duplicate behaviour. A failed push leaves the effect `pending`, which the
 * same watchdog pass or a later pass can re-push.
 *
 * @param {{store: import('../store/types.js').Store,
 *   pushEffect: (event: EffectQueueEvent) => Promise<unknown>,
 *   keyFor?: (input: EnqueueEffectInput) => string}} options
 * @returns {(input: EnqueueEffectInput) => Promise<{requestKey: string,
 *   created: boolean}>}
 */
export function createStoreEffectEnqueuer(options) {
  const { store, pushEffect } = options;
  const keyFor = options.keyFor ?? requestKeyFor;

  return async function enqueueEffect(input) {
    const requestKey = keyFor(input);
    const { created } = await store.putEffectIfAbsent({
      requestKey,
      runId: input.runId,
      stepId: input.stepId,
      kind: input.kind,
      payload: input.payload ?? {},
    });
    if (created) {
      await pushEffect({ requestKey });
    }
    return { requestKey, created };
  };
}

/**
 * Fresh-state check that a row returned by `findStuckSteps` is still stuck.
 * `findStuckSteps` returns a snapshot; a worker may have finished the step
 * before this watchdog pass reads it. This check also stops two overlapping
 * watchdog invocations from both advancing the same attempt.
 *
 * @param {import('../store/types.js').Step} step
 * @param {number} nowMs
 * @returns {boolean}
 */
function isStillStuck(step, nowMs) {
  if (step.status === 'running') {
    return Number.isFinite(step.deadlineAt) && step.deadlineAt < nowMs;
  }
  if (step.status === 'queued') {
    // A queued row normally has no deadline: the ten-minute createdAt rule
    // applies. The watchdog writes a deadline when it re-queues a retried
    // step, and that new deadline is the right signal until WP3 claims it.
    if (Number.isFinite(step.deadlineAt)) {
      return step.deadlineAt < nowMs;
    }
    return (
      Number.isFinite(step.createdAt) &&
      step.createdAt < nowMs - STUCK_QUEUED_MS
    );
  }
  return false;
}

/**
 * Human-readable Epic comment for a step that exhausted its retries.
 *
 * @param {import('../store/types.js').Run} run
 * @param {import('../store/types.js').Step} step
 * @param {number} nowMs
 * @returns {string}
 */
function buildFailureComment(run, step, nowMs) {
  return [
    '[Conductor watchdog] Step retry budget exhausted; the run is blocked.',
    `Run: ${run.runId}`,
    `Goal: ${run.goal}`,
    `Step ${step.idx + 1}: ${step.title} (${step.workerType})`,
    `Attempt: ${step.attempt}`,
    `Time: ${new Date(nowMs).toISOString()}`,
  ].join('\n');
}

/**
 * A retry or an exhausted step becomes a proposed lesson. The watchdog pass
 * still finishes if memory is unavailable.
 *
 * @param {import('../store/types.js').Store} store
 * @param {import('../store/types.js').Step} step
 * @param {string} kind
 * @param {unknown} error
 * @returns {Promise<void>}
 */
async function noteWatchdogLesson(store, step, kind, error) {
  try {
    const { recordFailureLesson } = await import('../memory/lessons.js');
    const run = await store.getRun(step.runId);
    if (!run) {
      return;
    }
    await recordFailureLesson({
      store,
      run,
      step,
      status: 'blocked',
      error,
      kind,
    });
  } catch {
    // The retry itself already succeeded.
  }
}

/**
 * Create a watchdog pass function with injected dependencies.
 *
 * @param {WatchdogDependencies} dependencies
 * @returns {{run: (options?: {now?: number}) => Promise<WatchdogSummary>}}
 */
export function createWatchdog(dependencies) {
  if (!dependencies || typeof dependencies !== 'object') {
    throw new TypeError('createWatchdog expects a dependency object');
  }
  const { store, pushStep, pushEffect } = dependencies;
  if (!store || typeof store !== 'object') {
    throw new TypeError('createWatchdog: store is required');
  }
  assertFunction(pushStep, 'pushStep');

  // Per-pass cache: several stuck steps of one run share one getRun read.
  // Cleared at the start of every pass and whenever the run is written.
  /** @type {Map<string, Promise<any>>} */
  const runCache = new Map();
  function getRunCached(runId) {
    if (!runCache.has(runId)) {
      runCache.set(runId, Promise.resolve().then(() => store.getRun(runId)).catch((error) => {
        runCache.delete(runId);
        throw error;
      }));
    }
    return runCache.get(runId);
  }
  assertFunction(pushEffect, 'pushEffect');

  for (const method of [
    'findStuckSteps',
    'getStep',
    'updateStep',
    'getRun',
    'updateRun',
    'listEffectsByStatus',
  ]) {
    assertFunction(store[method], `store.${method}`);
  }
  if (
    dependencies.enqueueEffect === undefined &&
    typeof store.putEffectIfAbsent !== 'function'
  ) {
    throw new TypeError(
      'createWatchdog: store.putEffectIfAbsent is required when enqueueEffect is not injected',
    );
  }
  if (dependencies.enqueueEffect !== undefined) {
    assertFunction(dependencies.enqueueEffect, 'enqueueEffect');
  }

  const clock = dependencies.now ?? (() => Date.now());
  assertFunction(clock, 'now');
  const env = dependencies.env ?? process.env;
  const logger = dependencies.logger ?? console;
  const concurrency = dependencies.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError('createWatchdog: concurrency must be a positive integer');
  }

  const enqueueEffect =
    dependencies.enqueueEffect ??
    createStoreEffectEnqueuer({ store, pushEffect });

  /**
   * Mark a run `blocked` with optimistic concurrency. A step failure may race
   * another step from the same run, so a conflict is re-read and retried.
   *
   * @param {string} runId
   * @returns {Promise<import('../store/types.js').Run|null>}
   */
  async function blockRun(runId) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const run = await getRunCached(runId);
      if (!run) {
        return null;
      }
      if (TERMINAL_RUN_STATUSES.includes(run.status)) {
        return run;
      }
      try {
        runCache.delete(runId);
        return await store.updateRun(
          runId,
          { status: 'blocked' },
          { expectedUpdatedAt: run.updatedAt },
        );
      } catch (error) {
        lastError = error;
        if (error?.code !== 'CONFLICT') {
          throw error;
        }
      }
    }
    throw lastError ?? new Error(`Unable to block run ${runId}`);
  }

  /**
   * Retry one stuck step: advance the attempt, set a fresh 12-minute
   * deadline, and push the WP3 event under the new attempt.
   *
   * @param {import('../store/types.js').Step} step
   * @param {number} nowMs
   * @returns {Promise<object>} Outcome for the pass summary.
   */
  async function retryStep(step, nowMs) {
    const nextAttempt = step.attempt + 1;
    const deadlineAt = nowMs + RETRY_DEADLINE_MS;
    // WP3's step worker only claims a `queued` step. Leaving the row
    // `running` would make the retry event look like an at-least-once
    // duplicate of the attempt that just hung, so re-queue it explicitly.
    // The worker overwrites `deadlineAt` again when it claims the step.
    await store.updateStep(step.stepId, {
      status: 'queued',
      attempt: nextAttempt,
      deadlineAt,
      output: undefined,
      error: undefined,
    });

    try {
      await pushStep({
        runId: step.runId,
        stepId: step.stepId,
        attempt: nextAttempt,
      });
    } catch (error) {
      // The attempt update succeeded but the event did not leave. Undo the
      // attempt and pull the deadline forward so the next pass tries again
      // instead of spending one of the three lives on a lost event.
      try {
        await store.updateStep(step.stepId, {
          status: 'queued',
          attempt: step.attempt,
          deadlineAt: nowMs - 1,
        });
      } catch {
        // Best effort. The next pass still sees an overdue running row.
      }
      return {
        status: 'error',
        stepId: step.stepId,
        runId: step.runId,
        attempt: step.attempt,
        errors: [
          {
            scope: 'step',
            id: step.stepId,
            ...describeError(error),
          },
        ],
      };
    }

    // A kill leaves the step `running` with no new status. The marker is
    // process memory from the worker. A stuck step that was not killed
    // does not match, and a closed gate does not enter this block, so a
    // normal retry does not read the run again.
    if (isFaultInjectionEnabled(env)) {
      const healed = await safeChaos(logger, () => recordKillHealed(store, step, env));
      if (healed) runCache.delete(step.runId);
    }

    await noteWatchdogLesson(store, step, 'watchdog-retry', {
      message: 'watchdog retried a stuck step',
    });
    const stallCount = (step.stallCount ?? 0) + 1;
    try {
      await store.updateStep(step.stepId, { stallCount });
    } catch (error) {
      // The retry itself succeeded. A missed stall counter must not rewind it.
      logger.warn?.('watchdog could not store stallCount', error);
    }

    await recordEvent(store, {
      runId: step.runId,
      kind: 'step.retried',
      stepId: step.stepId,
      stepIdx: step.idx,
      detail: {
        title: step.title,
        workerType: step.workerType,
        attempt: nextAttempt,
        stallCount,
      },
    });
    await recordEvent(store, {
      runId: step.runId,
      kind: 'watchdog.self-heal',
      stepId: step.stepId,
      stepIdx: step.idx,
      detail: {
        title: step.title,
        workerType: step.workerType,
        attempt: nextAttempt,
        stallCount,
      },
    });

    // Magentic-One: the second stall asks for a partial re-plan. The retry
    // above still happens so the attempt budget is unchanged. The replan
    // event is the request; it does not write to Jira and it is logged once.
    if (stallCount === STALL_REPLAN_THRESHOLD) {
      try {
        const steps = await store.listSteps(step.runId);
        const proposal = buildPartialReplan(steps, { ...step, stallCount });
        await recordEvent(store, {
          runId: step.runId,
          kind: 'replan',
          stepId: step.stepId,
          stepIdx: step.idx,
          detail: proposal,
        });
      } catch (error) {
        logger.warn?.('watchdog could not record a replan', error);
      }
    }

    return {
      status: 'retried',
      stepId: step.stepId,
      runId: step.runId,
      attempt: nextAttempt,
    };
  }

  /**
   * Terminal path: enqueue one deterministic Epic comment, block the run, and
   * mark the step failed. The comment is enqueued before the step leaves the
   * stuck index, so a crash between the two leaves a retry that dedupes.
   *
   * @param {import('../store/types.js').Step} step
   * @param {number} nowMs
   * @returns {Promise<object>} Outcome for the pass summary.
   */
  async function failStep(step, nowMs) {
    /** @type {WatchdogError[]} */
    const errors = [];
    /** @type {string|null} */
    let requestKey = null;
    /** @type {import('../store/types.js').Run|null} */
    let run = null;

    try {
      run = await getRunCached(step.runId);
    } catch (error) {
      errors.push({
        scope: 'run',
        id: step.runId,
        ...describeError(error),
      });
    }

    if (run && run.status !== 'done' && run.epicKey) {
      try {
        const result = await enqueueEffect({
          runId: run.runId,
          stepId: step.stepId,
          kind: 'comment',
          payload: {
            issueKey: run.epicKey,
            bodyText: buildFailureComment(run, step, nowMs),
          },
          discriminator: 'watchdog-blocked',
        });
        requestKey = result?.requestKey ?? null;
      } catch (error) {
        errors.push({
          scope: 'effect',
          id: step.stepId,
          ...describeError(error),
        });
      }
    }

    if (run && !TERMINAL_RUN_STATUSES.includes(run.status)) {
      try {
        await blockRun(step.runId);
      } catch (error) {
        errors.push({
          scope: 'run',
          id: step.runId,
          ...describeError(error),
        });
        // Do not mark the step failed: leaving it overdue lets the next pass
        // retry the block and dedupe the already-enqueued comment.
        return {
          status: 'error',
          stepId: step.stepId,
          runId: step.runId,
          attempt: step.attempt,
          errors,
        };
      }
    }

    const failure = {
      name: 'WatchdogAttemptsExhaustedError',
      code: 'WATCHDOG_ATTEMPTS_EXHAUSTED',
      message:
        `Watchdog stopped retrying this step at attempt ${step.attempt}; ` +
        `the retry budget is ${MAX_STEP_ATTEMPTS}.`,
      attempts: step.attempt,
      failedAt: nowMs,
    };

    try {
      await store.updateStep(step.stepId, {
        status: 'failed',
        attempt: step.attempt,
        deadlineAt: undefined,
        error: failure,
      });
      await recordEvent(store, {
        runId: step.runId,
        kind: 'step.failed',
        stepId: step.stepId,
        stepIdx: step.idx,
        detail: {
          title: step.title,
          workerType: step.workerType,
          attempt: step.attempt,
          status: 'failed',
          error: failure,
        },
      });
    } catch (error) {
      errors.push({
        scope: 'step',
        id: step.stepId,
        ...describeError(error),
      });
      return {
        status: 'error',
        stepId: step.stepId,
        runId: step.runId,
        attempt: step.attempt,
        errors,
      };
    }

    await noteWatchdogLesson(store, {
      ...step,
      status: 'failed',
      error: failure,
    }, 'watchdog-exhausted', failure);
    return {
      status: 'failed',
      stepId: step.stepId,
      runId: step.runId,
      attempt: step.attempt,
      requestKey,
      errors,
    };
  }

  /**
   * Process one row from `findStuckSteps`.
   *
   * @param {import('../store/types.js').Step} snapshot
   * @param {number} nowMs
   * @returns {Promise<object>} Outcome for the pass summary.
   */
  async function handleStuckStep(snapshot, nowMs) {
    const step = await store.getStep(snapshot.stepId);
    if (!step) {
      return {
        status: 'skipped',
        stepId: snapshot.stepId,
        runId: snapshot.runId,
        reason: 'missing',
      };
    }
    if (!isStillStuck(step, nowMs)) {
      return {
        status: 'skipped',
        stepId: step.stepId,
        runId: step.runId,
        reason: 'no-longer-stuck',
      };
    }
    // A gate is waiting on a person, not on the queue. Retrying it would
    // burn the three attempts and block the run. Steps that depend on the
    // gate are `waiting`, which `findStuckSteps` does not return. This
    // branch is the backstop for a gate that was left `queued` or `running`.
    // Parking it back to `waiting` stops the next pass from seeing it.
    // The attempt counter is not advanced, and nothing is pushed.
    if (isApprovalGate(step)) {
      if (step.status === 'queued' || step.status === 'running') {
        await store.updateStep(
          step.stepId,
          { status: 'waiting' },
          { expectedStatus: step.status },
        );
      }
      return {
        status: 'skipped',
        stepId: step.stepId,
        runId: step.runId,
        reason: 'approval-gate',
      };
    }
    // The lead asked a person. A queued row in that run is waiting on the
    // reply, not on the watchdog. Retrying it, or failing it after three
    // passes, would unblock work the human has not approved.
    const pausedRun = await getRunCached(step.runId);
    if (pausedRun?.status === 'awaiting-review') {
      return {
        status: 'skipped',
        stepId: step.stepId,
        runId: step.runId,
        reason: 'awaiting-review',
      };
    }
    if (step.attempt >= MAX_STEP_ATTEMPTS) {
      return failStep(step, nowMs);
    }
    return retryStep(step, nowMs);
  }

  /**
   * Re-push effects that have been pending or retrying for more than five
   * minutes. Their `updatedAt` is deliberately not changed: at-least-once
   * delivery is safe because the applier dedupes on the request key.
   *
   * @param {number} nowMs
   * @param {WatchdogSummary} summary
   * @returns {Promise<void>}
   */
  async function repushStaleEffects(nowMs, summary) {
    /** @type {Array<{status: string, effects?: import('../store/types.js').Effect[], error?: unknown}>} */
    const results = await Promise.all(
      EFFECT_STATUSES_TO_REPUSH.map(async (status) => {
        try {
          return {
            status,
            effects: await store.listEffectsByStatus(status),
          };
        } catch (error) {
          return { status, error };
        }
      }),
    );

    /** @type {Map<string, import('../store/types.js').Effect>} */
    const stale = new Map();
    for (const result of results) {
      if (result.error) {
        summary.errors.push({
          scope: 'effect',
          id: result.status,
          ...describeError(result.error),
        });
        continue;
      }
      for (const effect of result.effects ?? []) {
        if (
          Number.isFinite(effect.updatedAt) &&
          effect.updatedAt < nowMs - STALE_EFFECT_MS
        ) {
          stale.set(effect.requestKey, effect);
        }
      }
    }

    const outcomes = await mapWithConcurrency(
      [...stale.values()],
      concurrency,
      async (effect) => {
        try {
          // `applying` means an applier claimed the row. Only a stale claim
          // is released, and only one watchdog wins the compare-and-set.
          if (effect.status === 'applying') {
            try {
              await store.updateEffect(
                effect.requestKey,
                { status: 'retrying' },
                { expectedStatus: 'applying' },
              );
            } catch (error) {
              if (error?.code === 'CONFLICT' || error?.name === 'ConflictError') {
                return { status: 'skipped', requestKey: effect.requestKey };
              }
              throw error;
            }
          }
          await pushEffect({ requestKey: effect.requestKey });
          return { status: 'repushed', requestKey: effect.requestKey };
        } catch (error) {
          return {
            status: 'error',
            requestKey: effect.requestKey,
            error,
          };
        }
      },
    );

    for (const outcome of outcomes) {
      if (outcome.status === 'repushed') {
        summary.repushedEffects.push({ requestKey: outcome.requestKey });
      } else {
        summary.errors.push({
          scope: 'effect',
          id: outcome.requestKey,
          ...describeError(outcome.error),
        });
      }
    }
  }

  /**
   * Run one watchdog pass.
   *
   * @param {{now?: number}} [options] Override the clock for this pass.
   * @returns {Promise<WatchdogSummary>}
   */
  async function run(options = {}) {
    const nowMs = assertFiniteNumber(
      options.now === undefined ? clock() : options.now,
    );
    runCache.clear();
    /** @type {WatchdogSummary} */
    const summary = {
      now: nowMs,
      demoStuck: isDemoStuckEnabled(env),
      scannedSteps: 0,
      retriedSteps: [],
      failedSteps: [],
      skippedSteps: [],
      repushedEffects: [],
      errors: [],
    };

    let stuckSteps = [];
    try {
      stuckSteps = await store.findStuckSteps(nowMs);
    } catch (error) {
      summary.errors.push({
        scope: 'step',
        id: 'findStuckSteps',
        ...describeError(error),
      });
    }
    summary.scannedSteps = stuckSteps.length;

    const stepOutcomes = await mapWithConcurrency(
      stuckSteps,
      concurrency,
      async (snapshot) => {
        try {
          return await handleStuckStep(snapshot, nowMs);
        } catch (error) {
          return {
            status: 'error',
            stepId: snapshot.stepId,
            runId: snapshot.runId,
            attempt: snapshot.attempt,
            errors: [
              {
                scope: 'step',
                id: snapshot.stepId,
                ...describeError(error),
              },
            ],
          };
        }
      },
    );

    for (const outcome of stepOutcomes) {
      summary.errors.push(...(outcome.errors ?? []));
      if (outcome.status === 'retried') {
        summary.retriedSteps.push({
          stepId: outcome.stepId,
          runId: outcome.runId,
          attempt: outcome.attempt,
        });
      } else if (outcome.status === 'failed') {
        summary.failedSteps.push({
          stepId: outcome.stepId,
          runId: outcome.runId,
          attempt: outcome.attempt,
          requestKey: outcome.requestKey,
        });
      } else if (outcome.status === 'skipped') {
        summary.skippedSteps.push({
          stepId: outcome.stepId,
          runId: outcome.runId,
          reason: outcome.reason,
        });
      }
    }

    await repushStaleEffects(nowMs, summary);

    const log = summary.errors.length > 0 ? logger.warn : logger.info;
    if (typeof log === 'function') {
      log.call(
        logger,
        `[watchdog] scanned=${summary.scannedSteps} ` +
          `retried=${summary.retriedSteps.length} ` +
          `failed=${summary.failedSteps.length} ` +
          `effects=${summary.repushedEffects.length} ` +
          `errors=${summary.errors.length}`,
      );
    }

    return summary;
  }

  return { run };
}
