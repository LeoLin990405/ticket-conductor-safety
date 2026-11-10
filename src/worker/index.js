/**
 * Step worker consumer and worker-type registry for Ticket Conductor (WP3).
 *
 * Forge invokes the `step-worker` consumer once per `{runId, stepId, attempt}`
 * event (docs/DESIGN.md §2.3). Delivery is at-least-once, so this handler must
 * be idempotent:
 *
 * 1. a missing step, a terminal step, or an event for an older/future attempt
 *    exits without side effects;
 * 2. a queued step is claimed (`status=running`, `deadlineAt=now+12min`) under
 *    an in-process lock;
 * 3. the registered worker type runs and returns `{output, effects}`;
 * 4. effects are handed to WP2's idempotent queue with stable discriminators;
 * 5. `reportStep` persists the output and recomputes the run.
 *
 * Built-in worker types call the Forge LLM when the runtime provides it and
 * otherwise use a deterministic fallback (WP11, `src/worker/LLM.md`). A test
 * can pass `overrides.llm` with a mock `{chat, list}`. Tests may also
 * register extra types (for example a deliberately failing one) through
 * `registerWorkerType`. The model never registers a type and never chooses
 * the Jira effect.
 *
 * @module worker
 */

import { EFFECT_KINDS, NotFoundError, StoreValidationError } from '../store/index.js';

import {
  deadlineFor,
  reportStep,
} from '../run/stateMachine.js';
import { resolveDependencies } from '../run/dependencies.js';
import { withLock } from '../run/locks.js';
import { recordEvent } from '../recorder/log.js';
import { recordFaultInjected, safeChaos } from '../chaos/counters.js';
import { isFaultInjectionEnabled, takeKillWorker } from '../chaos/faults.js';
import { demoHangDelayMs, shouldDemoHang } from '../watchdog/demo.js';
import { briefForStep } from '../skills/brief.js';
import { SkillContractError } from '../skills/errors.js';
import { tryLoadSkill } from '../skills/library.js';
import { runSubAgent } from '../skills/runSubAgent.js';
import { coalesceCommentEffects } from '../effects/commentBatch.js';
import { transitionEffect } from './content.js';
import { isApprovalGate } from '../run/approval.js';
import {
  checkDepsWorker,
  draftSpecWorker,
  researchWorker,
  summarizeWorker,
} from './workerTypes.js';

/**
 * @typedef {(step: import('../store/types.js').Step, ctx: object) => Promise<{output?: any, effects?: Array<object>}>} WorkerTypeHandler
 */

/** In-process registry of worker type name -> handler. @type {Map<string, WorkerTypeHandler>} */
const workerTypes = new Map();

/**
 * Register or replace a worker type.
 *
 * Worker names are part of the Router plan contract (`docs/TASKS.md`, WP5), so
 * they use lowercase letters, digits, and single hyphens only.
 *
 * @param {string} name Worker type name, e.g. `research`.
 * @param {WorkerTypeHandler} handler Async `(step, ctx) => ({output, effects})`.
 * @returns {WorkerTypeHandler|undefined} The previous handler, if this replaced one.
 */
export function registerWorkerType(name, handler) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new StoreValidationError(
      'registerWorkerType name must be lowercase letters, digits, and hyphens',
    );
  }
  if (typeof handler !== 'function') {
    throw new StoreValidationError('registerWorkerType handler must be a function');
  }
  const previous = workerTypes.get(name);
  workerTypes.set(name, handler);
  return previous;
}

/**
 * Look up a worker type without running it.
 *
 * @param {string} name
 * @returns {WorkerTypeHandler|undefined}
 */
export function getWorkerType(name) {
  return workerTypes.get(name);
}

/**
 * List the registered worker type names. WP5 validates plans against this.
 *
 * @returns {string[]}
 */
export function listWorkerTypes() {
  return [...workerTypes.keys()].sort();
}

/**
 * Remove one worker type. Used by tests that install a temporary type.
 *
 * @param {string} name
 * @returns {boolean} True when a handler was removed.
 */
export function unregisterWorkerType(name) {
  return workerTypes.delete(name);
}

/**
 * Registered so `plan-split` accepts `workerType: 'approval'`.
 *
 * The step consumer does not call this. It parks the gate as `waiting`
 * before the claim, so a gate event does not enqueue a comment and does
 * not report the step `done`. A direct call returns no effects.
 *
 * @returns {Promise<{output: {awaiting: string}, effects: Array<never>}>}
 */
export async function approvalWorker() {
  return {
    output: { awaiting: 'approval' },
    effects: [],
  };
}

/**
 * Restore the registry to the built-in workers, including `approval`.
 *
 * @returns {void}
 */
export function resetWorkerTypes() {
  workerTypes.clear();
  registerWorkerType('research', researchWorker);
  registerWorkerType('draft-spec', draftSpecWorker);
  registerWorkerType('check-deps', checkDepsWorker);
  registerWorkerType('summarize', summarizeWorker);
  registerWorkerType('approval', approvalWorker);
}

// The built-ins are always present when this module is imported. Tests can add
// temporary types with registerWorkerType and call resetWorkerTypes afterwards.
resetWorkerTypes();

/**
 * Accept both consumer and direct-call event shapes.
 *
 * A Forge async consumer receives an event whose payload is `event.body`
 * (docs/SPIKES.md). Tests and internal callers often pass the payload
 * directly, so both are supported.
 *
 * @param {any} event
 * @returns {Record<string, any>}
 */
function eventPayload(event) {
  if (event && typeof event === 'object' && event.body) {
    return event.body;
  }
  return event;
}

/**
 * Serialise an error for the step record. Stack traces are omitted because
 * they add noise to the UI and can be large; the message and code are enough to
 * debug a failed step.
 *
 * @param {unknown} error
 * @returns {{name: string, message: string, code?: string}}
 */
function serializeError(error) {
    if (error instanceof Error) {
    /** @type {{name: string, message: string, code?: string, details?: string[]}} */
    const serialized = {
      name: error.name || 'Error',
      message: error.message || String(error),
    };
    if (typeof /** @type {any} */ (error).code === 'string') {
      serialized.code = /** @type {any} */ (error).code;
    }
    if (Array.isArray(/** @type {any} */ (error).details)) {
      serialized.details = /** @type {any} */ (error).details;
    }
    return serialized;
  }
  return { name: 'Error', message: String(error) };
}

/**
 * Validate one worker effect descriptor before it reaches WP2.
 *
 * @param {any} effect
 * @param {number} index
 * @returns {{kind: string, payload: object, discriminator?: string}}
 */
function normalizeEffect(effect, index) {
  if (!effect || typeof effect !== 'object' || Array.isArray(effect)) {
    throw new StoreValidationError(
      `worker effect ${index} must be an object`,
    );
  }
  if (!EFFECT_KINDS.includes(effect.kind)) {
    throw new StoreValidationError(
      `worker effect ${index} kind must be one of ${EFFECT_KINDS.join(', ')}`,
    );
  }
  const payload =
    effect.payload === undefined
      ? {}
      : effect.payload && typeof effect.payload === 'object'
        ? effect.payload
        : (() => {
            throw new StoreValidationError(
              `worker effect ${index} payload must be an object`,
            );
          })();
  if (
    effect.discriminator !== undefined &&
    (typeof effect.discriminator !== 'string' ||
      effect.discriminator.length === 0)
  ) {
    throw new StoreValidationError(
      `worker effect ${index} discriminator must be a non-empty string`,
    );
  }
  return {
    kind: effect.kind,
    payload,
    discriminator: effect.discriminator,
  };
}

/**
 * Mark a claimed step failed and let the run state machine block the run.
 *
 * @param {object} dependencies
 * @param {import('../store/types.js').Step} step
 * @param {unknown} error
 * @returns {Promise<object>}
 */
async function failStep(dependencies, step, error, modelMeter) {
  const serialized = serializeError(error);
  // Skill-contract failures (unknown schema after the one repair, a tool
  // outside the brief, a blown tool budget) block the step. A thrown worker
  // bug still fails it. Both block the run; the status tells them apart.
  const blocked = error instanceof SkillContractError || error?.status === 'blocked';
  const status = blocked ? 'blocked' : 'failed';
  const result = await reportStep(
    step.stepId,
    { status, error: serialized },
    { ...dependencies, modelMeter },
  );
  return {
    status,
    step: result.step,
    run: result.run,
    error: serialized,
  };
}

/**
 * Consumer for the `step-queue` (docs/TASKS.md, WP3).
 *
 * @param {{body?: {runId: string, stepId: string, attempt: number}, runId?: string, stepId?: string, attempt?: number}} event
 * @param {Partial<import('../run/dependencies.js').Wp3Dependencies>} [overrides]
 * @returns {Promise<object>} A small result object used by tests/observability.
 */
export async function stepWorkerHandler(event, overrides) {
  const dependencies = resolveDependencies(overrides);
  const payload = eventPayload(event);
  if (!payload || typeof payload !== 'object') {
    throw new StoreValidationError('stepWorkerHandler event payload is required');
  }

  const { runId, stepId } = payload;
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new StoreValidationError('stepWorkerHandler runId is required');
  }
  if (typeof stepId !== 'string' || stepId.length === 0) {
    throw new StoreValidationError('stepWorkerHandler stepId is required');
  }
  if (
    payload.attempt !== undefined &&
    (!Number.isInteger(payload.attempt) || payload.attempt < 0)
  ) {
    throw new StoreValidationError(
      'stepWorkerHandler attempt must be a non-negative integer',
    );
  }

  const initialStep = await dependencies.store.getStep(stepId);
  if (!initialStep) {
    dependencies.logger.warn(
      `WP3 ignoring step event for missing step ${stepId}`,
    );
    return { status: 'ignored', reason: 'missing-step' };
  }
  if (initialStep.runId !== runId) {
    dependencies.logger.warn(
      `WP3 ignoring step event: step ${stepId} belongs to run ${initialStep.runId}, not ${runId}`,
    );
    return { status: 'ignored', reason: 'run-mismatch' };
  }

  // If the event omits attempt, use the stored attempt. The queue contract
  // normally supplies it, but this makes direct calls and old events forgiving.
  const attempt = payload.attempt ?? initialStep.attempt;
  if (attempt !== initialStep.attempt) {
    return {
      status: 'stale',
      reason: 'attempt-mismatch',
      step: initialStep,
    };
  }

  return withLock(`step:${stepId}`, async () => {
    // Re-read inside the lock: another delivery may have claimed the step while
    // this one was waiting.
    const step = await dependencies.store.getStep(stepId);
    if (!step) {
      return { status: 'ignored', reason: 'missing-step' };
    }

    if (attempt < step.attempt) {
      return { status: 'stale', reason: 'older-attempt', step };
    }
    if (attempt > step.attempt) {
      // A future attempt means the watchdog has not persisted its increment
      // yet, or the event is corrupt. Running would race the real attempt.
      return { status: 'stale', reason: 'future-attempt', step };
    }

    if (
      step.status === 'done' ||
      step.status === 'failed' ||
      step.status === 'blocked'
    ) {
      return { status: 'duplicate', reason: 'terminal-step', step };
    }
    // Park before the claim. Claiming would set `running` and a deadline,
    // and the watchdog would then treat the gate as stuck. `waiting` is
    // the status that scan does not query. No `step.started` event is
    // written, and no effect is enqueued.
    if (isApprovalGate(step) && (step.status === 'queued' || step.status === 'running')) {
      const parked = await dependencies.store.updateStep(
        step.stepId,
        { status: 'waiting' },
        { expectedStatus: step.status },
      );
      return {
        status: 'parked',
        reason: 'awaiting-approval',
        step: parked || step,
      };
    }
    if (isApprovalGate(step)) {
      return { status: 'ignored', reason: 'awaiting-approval', step };
    }
    if (step.status === 'running') {
      // At-least-once delivery of the same attempt. The first delivery owns the
      // step; a crashed delivery is retried by WP4 with attempt+1.
      return { status: 'duplicate', reason: 'already-running', step };
    }
    if (step.status !== 'queued') {
      return { status: 'ignored', reason: `unexpected-status:${step.status}` };
    }

    const handler = workerTypes.get(step.workerType);
    // A pack with no JavaScript worker (test-plan, risk-review, or a file
    // dropped in later) still runs. A name that is neither a worker nor a
    // pack is the old unknown-worker failure.
    const pack = tryLoadSkill(step.skill || step.workerType);
    if (!handler && !pack) {
      const unknown = new Error(
        `Unknown workerType "${step.workerType}" for step ${step.stepId}`,
      );
      unknown.code = 'UNKNOWN_WORKER_TYPE';
      return failStep(dependencies, step, unknown);
    }

    const startedAt = dependencies.now();
    const runForBrief = await dependencies.store.getRun(step.runId);
    const prepared = briefForStep(step, runForBrief);
    /** @type {Record<string, any>} */
    const claim = {
      status: 'running',
      attempt,
      deadlineAt: deadlineFor(startedAt),
      error: undefined,
      brief: prepared.brief,
    };
    // Omit skill when there is no pack. An empty string is not a valid
    // Forge string attribute, and `undefined` in a patch drops the field.
    if (prepared.skill) {
      claim.skill = prepared.skill;
    }
    let claimedStep;
    try {
      claimedStep = await dependencies.store.updateStep(step.stepId, claim);
    } catch (error) {
      if (error instanceof NotFoundError || error?.name === 'NotFoundError') {
        return { status: 'ignored', reason: 'missing-step' };
      }
      throw error;
    }

    await recordEvent(dependencies.store, {
      runId: claimedStep.runId,
      kind: 'step.started',
      stepId: claimedStep.stepId,
      stepIdx: claimedStep.idx,
      detail: {
        title: claimedStep.title,
        workerType: claimedStep.workerType,
        skill: claimedStep.skill || null,
        attempt,
      },
    });

    // `llm` and `confluence` are optional. Production leaves them unset: the
    // worker loads `@forge/llm` and Confluence only inside a Forge invocation.
    // Tests pass a mock `llm` or a `confluence.search` stub here.
    // Replay passes `llm: { disabled: true }` so this consumer is not used
    // for a dry-run and the model is not called.
    // In-memory chat counter for this attempt. `reportStep` flushes it once
    // under the run lock. It is not the step brief's tool budget.
    const modelMeter = { calls: 0, tokens: 0 };
    const ctx = {
      run: await dependencies.store.getRun(claimedStep.runId),
      store: dependencies.store,
      jira: dependencies.jira,
      logger: dependencies.logger,
      now: dependencies.now,
      attempt,
      deadlineAt: claimedStep.deadlineAt,
      childIssueKey: claimedStep.childIssueKey,
      llm: overrides?.llm,
      confluence: overrides?.confluence,
      useForgeRetrieval: overrides?.useForgeRetrieval,
      modelMeter,
    };
    // Chaos kill. Installed only when the simulation or development flag is
    // on, so a production worker has no `faultCheckpoint` and the composers
    // skip the hook. The checkpoint runs after the worker has started its
    // own reads (`after-evidence`). Throwing here leaves the step `running`:
    // effects are not queued and `reportStep` is not called. The watchdog
    // retries a running step whose deadline has passed. This is not the
    // demo hang, which returns before the worker body.
    if (isFaultInjectionEnabled(dependencies.env)) {
      ctx.faultCheckpoint = (at) => {
        const fault = takeKillWorker(claimedStep, dependencies.env);
        if (!fault) return undefined;
        const error = new Error(
          'Fault injection killed this worker mid-step. The step stays running.',
        );
        error.name = 'WorkerKilled';
        error.code = 'FAULT_KILL_WORKER';
        error.at = typeof at === 'string' && at.length > 0 ? at : 'mid-step';
        throw error;
      };
    }
    if (!ctx.run) {
      return failStep(
        dependencies,
        claimedStep,
        new Error(`Run ${claimedStep.runId} disappeared while starting a step`),
      );
    }

    // Demo switch owned by WP4. Hang once, on attempt 0, and leave the step
    // running so the watchdog can retry it. The sleep is injectable so tests
    // do not wait out the 12 minute deadline.
    if (shouldDemoHang(claimedStep, dependencies.env)) {
      const delay = demoHangDelayMs(claimedStep, {
        env: dependencies.env,
        now: dependencies.now(),
      });
      await dependencies.sleep(delay);
      return {
        status: 'demo-hang',
        reason: 'demo-stuck-step',
        step: claimedStep,
      };
    }

    /** @type {{output?: any, effects?: Array<object>}} */
    let result;
    try {
      if (pack) {
        // Load the body here, at run time. The Router only saw the name.
        result = await runSubAgent({
          step: claimedStep,
          ctx,
          skill: pack,
          handler,
          brief: prepared.brief,
        });
      } else {
        result = await handler(claimedStep, ctx);
      }
    } catch (error) {
      if (error?.code === 'FAULT_KILL_WORKER') {
        // The fault already fired. Count it on the run, then leave the
        // step `running` so the watchdog is the thing that retries it.
        // A counter write must not turn this into a failed step.
        if (isFaultInjectionEnabled(dependencies.env)) {
          await safeChaos(dependencies.logger, () => recordFaultInjected(
            dependencies.store,
            {
              runId: claimedStep.runId,
              stepId: claimedStep.stepId,
              kind: 'kill-worker',
            },
            dependencies.env,
          ));
        }
        return {
          status: 'killed',
          reason: 'fault-injection',
          fault: 'kill-worker',
          at: typeof error.at === 'string' ? error.at : 'mid-step',
          step: claimedStep,
        };
      }
      dependencies.logger.error(
        `WP3 worker "${claimedStep.workerType}" failed for step ${step.stepId}`,
        error,
      );
      return failStep(dependencies, claimedStep, error, modelMeter);
    }

    // A worker that never calls `faultCheckpoint` (a checklist pack, or a
    // test double) can still be killed here: the body returned, and nothing
    // has been queued yet. A checkpoint that already consumed the fault
    // does not reach this line, because it throws.
    if (isFaultInjectionEnabled(dependencies.env) && takeKillWorker(claimedStep, dependencies.env)) {
      await safeChaos(dependencies.logger, () => recordFaultInjected(
        dependencies.store,
        {
          runId: claimedStep.runId,
          stepId: claimedStep.stepId,
          kind: 'kill-worker',
        },
        dependencies.env,
      ));
      return {
        status: 'killed',
        reason: 'fault-injection',
        fault: 'kill-worker',
        at: 'before-effects',
        step: claimedStep,
      };
    }

    const output = result?.output;
    const rawEffects = Array.isArray(result?.effects) ? result.effects : [];

    try {
      // Drop effects if the watchdog has already moved the step to a newer
      // attempt while the handler was running. This is the "stale attempt exits
      // without effects" rule from docs/TASKS.md.
      const latest = await dependencies.store.getStep(step.stepId);
      if (
        !latest ||
        latest.attempt !== attempt ||
        latest.status !== 'running'
      ) {
        return {
          status: 'stale',
          reason: 'attempt-changed-before-effects',
          step: latest,
        };
      }

      // Append the plan's transition after the worker's own effects. A step
      // with no `transitionTo` adds nothing, so the effect list is unchanged.
      const plannedTransitions = transitionEffect(latest, ctx.run);
      const effectsToQueue = plannedTransitions.length > 0
        ? [...rawEffects, ...plannedTransitions]
        : rawEffects;
      // One completion, one list. Comments that name the same child become
      // one effect before any of them is pushed. A transition stays its own
      // effect. A comment that is already the only one for its issue is
      // returned unchanged, so its request key does not move.
      const normalized = [];
      for (let index = 0; index < effectsToQueue.length; index += 1) {
        normalized.push(normalizeEffect(effectsToQueue[index], index));
      }
      const coalesced = coalesceCommentEffects(normalized, latest);
      const enqueued = [];
      for (let index = 0; index < coalesced.length; index += 1) {
        const effect = coalesced[index];
        const queued = await dependencies.enqueueEffect({
          runId: claimedStep.runId,
          stepId: claimedStep.stepId,
          kind: effect.kind,
          payload: effect.payload,
          discriminator: effect.discriminator ?? `${effect.kind}:${index}`,
        });
        enqueued.push(queued);
      }

      // WP6 owns the Epic "[Conductor memory]" comment and the memory rows.
      // The summarize worker only produces the summary and decisions. Posting
      // the comment here as well duplicated it (different request keys).
      if (
        claimedStep.workerType === 'summarize' &&
        output &&
        typeof output === 'object'
      ) {
        try {
          if (
            typeof output.summary === 'string' &&
            output.summary.length > 0
          ) {
            await dependencies.store.updateRun(claimedStep.runId, {
              summary: output.summary,
            });
          }
          const { writeBack } = await import('../memory/index.js');
          await writeBack(
            claimedStep.runId,
            {
              summary: output.summary,
              decisions: Array.isArray(output.decisions) ? output.decisions : [],
            },
            {
              store: dependencies.store,
              enqueueEffect: dependencies.enqueueEffect,
            },
          );
        } catch (error) {
          dependencies.logger.error(
            `WP3 could not write back memory for ${claimedStep.runId}`,
            error,
          );
          return failStep(dependencies, claimedStep, error, modelMeter);
        }
      }

      const report = await reportStep(
        claimedStep.stepId,
        { status: 'done', output },
        {
          ...dependencies,
          // The same client the worker just used, when a test or the runtime
          // passed one. The lead falls back to rules when this is missing.
          llm: overrides?.llm ?? dependencies.llm,
          modelMeter,
        },
      );
      return {
        status: 'done',
        step: report.step,
        run: report.run,
        output,
        effects: enqueued,
      };
    } catch (error) {
      dependencies.logger.error(
        `WP3 could not finish step ${claimedStep.stepId}`,
        error,
      );
      return failStep(dependencies, claimedStep, error, modelMeter);
    }
  });
}
