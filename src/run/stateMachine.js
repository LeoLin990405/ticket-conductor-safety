/**
 * Run state machine for Ticket Conductor (WP3).
 *
 * Responsibilities (docs/TASKS.md, WP3):
 * - `startRun` moves a run from `planning` to `running`, enqueues each step
 *   whose dependencies are already `done` on `step-queue`, and emits one
 *   deterministic `createIssue` effect per step so each step gets a Jira
 *   child issue. An `approval` gate is created the same way and then left
 *   `waiting` until `approveGate`. It is not pushed to `step-queue`.
 * - `reportStep` records a worker/trigger result and recomputes the run status.
 * - `recomputeRunStatus` derives the run status from its steps: any failed or
 *   blocked step blocks the run; all steps done completes the run and appends a
 *   `summarize` step that writes the run summary/decisions for WP6.
 *
 * Status ownership:
 * - WP3 only changes a run while it is `planning` or `running`.
 * - `done`, `blocked`, and `failed` are terminal here. A late or duplicate
 *   report cannot reopen a finished run.
 *
 * Jira writes are never performed here. The `createIssue` effect is handed to
 * WP2's `enqueueEffect`; WP2's applier performs the REST call and stores the
 * child issue key on the step.
 *
 * All functions accept an optional dependency object as their last argument.
 * Production calls `startRun(runId)` and uses the lazy defaults from
 * `dependencies.js`; tests pass a memory store plus a stub effects queue.
 *
 * @module run/stateMachine
 */

import {
  ConflictError,
  NotFoundError,
  STEP_STATUSES,
  StoreValidationError,
} from '../store/index.js';

import { stepResultKey } from '../recorder/journal.js';
import { recordEvent } from '../recorder/log.js';
import { compactDetail } from '../recorder/stable.js';
import { resolveDependencies, STEP_DEADLINE_MS } from './dependencies.js';
import {
  dependenciesSatisfied,
  dependencyContextFor,
  normalizePlanGraph,
} from './graph.js';
import { withLock } from './locks.js';
import { briefForStep } from '../skills/brief.js';
import { maybeReviewWave } from './leadLoop.js';
import { workSteps } from './digest.js';
import { planCardFromSteps, previewBlastRadius } from '../blast/preview.js';
import { isApprovalGate, stepIdsBlockedByOpenApproval } from './approval.js';
import { applyBudgetStop, applyRunBudget, commitRunBudget, runBudgetStop } from './budget.js';
import { authorizeDispatchShared } from '../safety/grants.js';

/**
 * Statuses after which a run must not change again in WP3.
 * @constant {ReadonlyArray<import('../store/types.js').RunStatus>}
 */
const TERMINAL_RUN_STATUSES = Object.freeze(['done', 'blocked', 'failed']);

/**
 * Worker type of the automatic closing step.
 * @constant {string}
 */
export const SUMMARIZE_WORKER_TYPE = 'summarize';

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/**
 * Append the sub-agent brief to the child issue description when the step
 * has one. Steps created before WP15 have no brief, and the description
 * stays the goal plus the title.
 *
 * @param {string} description
 * @param {import('../store/types.js').Step} step
 * @returns {string}
 */
function appendBrief(description, step) {
  const brief = step.brief;
  if (!brief || typeof brief !== 'object') {
    return description;
  }
  const tools = Array.isArray(brief.allowedTools) && brief.allowedTools.length > 0
    ? brief.allowedTools.join(', ')
    : 'none';
  const budget = brief.budget || {};
  return [
    description,
    '',
    'Sub-agent brief',
    `Objective: ${brief.objective || ''}`,
    `Allowed tools: ${tools}`,
    `Done when: ${brief.doneWhen || ''}`,
    `Budget: ${budget.maxToolCalls ?? 0} tool calls, ${budget.maxOutputBytes ?? 0} output bytes, ${budget.maxRepairAttempts ?? 1} repair`,
  ].join('\n');
}

/**
 * Build the WP2 `createIssue` payload for one step.
 *
 * `parentKey` is the Epic. The default issue type is `Sub-task`; a plan may
 * override it through `step.input.issueType` for projects that use a custom
 * child issue type.
 *
 * @param {import('../store/types.js').Run} run
 * @param {import('../store/types.js').Step} step
 * @returns {{projectKey: string, parentKey: string, summary: string, description: string, issueType: string}}
 */
export function buildCreateIssuePayload(run, step) {
  const input = asRecord(step.input);
  const description = appendBrief(
    typeof input.description === 'string' && input.description.length > 0
      ? input.description
      : `Goal: ${run.goal}\n\nStep: ${step.title}`,
    step,
  );
  return {
    projectKey: run.projectKey,
    parentKey: run.epicKey,
    summary: step.title,
    description,
    issueType:
      typeof input.issueType === 'string' && input.issueType.length > 0
        ? input.issueType
        : 'Sub-task',
  };
}

/**
 * Read a run or throw the shared store `NotFoundError`.
 *
 * @param {import('../store/types.js').Store} store
 * @param {string} runId
 * @returns {Promise<import('../store/types.js').Run>}
 */
async function requireRun(store, runId) {
  const run = await store.getRun(runId);
  if (!run) {
    throw new NotFoundError('run', runId);
  }
  return run;
}

/**
 * Patch a run with optimistic concurrency and a small retry loop.
 *
 * The in-process run lock already serialises WP3 work for one run, but a trigger
 * or the UI can update the same run from another function instance. Retrying a
 * `ConflictError` against the freshly read `updatedAt` keeps the state machine
 * usable under that normal Forge concurrency.
 *
 * @param {import('../store/types.js').Store} store
 * @param {string} runId
 * @param {Partial<import('../store/types.js').Run>} patch
 * @returns {Promise<import('../store/types.js').Run>}
 */
async function patchRun(store, runId, patch) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await requireRun(store, runId);
    try {
      return await store.updateRun(runId, patch, {
        expectedUpdatedAt: current.updatedAt,
      });
    } catch (error) {
      lastError = error;
      if (!(error instanceof ConflictError) && error?.name !== 'ConflictError') {
        throw error;
      }
    }
  }
  throw lastError;
}

/**
 * Append the automatic `summarize` step exactly once.
 *
 * The step is generated after the run reaches `done`. It has no child issue:
 * its job is to concatenate the completed step outputs and emit the
 * `[Conductor memory]` Epic comment that WP6 later turns into memory records.
 *
 * @param {object} dependencies Resolved WP3 dependencies.
 * @param {import('../store/types.js').Run} run
 * @param {import('../store/types.js').Step[]} steps
 * @returns {Promise<import('../store/types.js').Step|null>}
 */
export async function ensureSummarizeStep(dependencies, run, steps) {
  if (steps.some((step) => step.workerType === SUMMARIZE_WORKER_TYPE)) {
    return null;
  }

  let summarizeStep;
  try {
    // Deterministic id + putIfAbsent: two steps finishing in separate Forge
    // invocations (the in-process run lock does not span them) both get here,
    // but only one write creates the summarize step.
    [summarizeStep] = await dependencies.store.createSteps(
      run.runId,
      [
        {
          title: `Summarize run: ${run.goal}`,
          workerType: SUMMARIZE_WORKER_TYPE,
          input: { auto: true },
        },
      ],
      { stepIds: [`${run.runId}-summarize`] },
    );
    if (!summarizeStep) {
      return null;
    }
    await recordEvent(dependencies.store, {
      runId: run.runId,
      kind: 'step.queued',
      stepId: summarizeStep.stepId,
      stepIdx: summarizeStep.idx,
      detail: {
        title: summarizeStep.title,
        workerType: summarizeStep.workerType,
        auto: true,
      },
    });
  } catch (error) {
    dependencies.logger.error('WP3 could not create the summarize step', error);
    return null;
  }

  try {
    await dependencies.enqueueStep({
      runId: run.runId,
      stepId: summarizeStep.stepId,
      attempt: summarizeStep.attempt,
    });
  } catch (error) {
    // The step is queued in storage; WP4's watchdog will retry it after the
    // queued-age threshold even if this immediate enqueue fails.
    dependencies.logger.error('WP3 could not enqueue the summarize step', error);
  }

  return summarizeStep;
}

/**
 * Recompute a run status without taking the run lock.
 *
 * Called from `reportStep` while it already holds `run:<runId>`.
 *
 * @param {object} dependencies Resolved WP3 dependencies.
 * @param {string} runId
 * @returns {Promise<import('../store/types.js').Run>}
 */
async function recomputeRunStatusUnlocked(dependencies, runId) {
  const run = await requireRun(dependencies.store, runId);

  // Terminal runs stay terminal. The automatic summarize step may still run
  // after the run is done, but it cannot change the run back to running.
  if (TERMINAL_RUN_STATUSES.includes(run.status)) {
    return run;
  }

  // The lead asked a person. Steps stay as they are until that person
  // replies or transitions the Epic. A duplicate step report must not
  // stop the run or spawn the next wave on its own.
  if (run.status === 'awaiting-review') {
    return run;
  }

  const steps = await dependencies.store.listSteps(runId);
  const blocked = steps.some(
    (step) => step.status === 'failed' || step.status === 'blocked',
  );

  if (blocked) {
    if (run.status === 'blocked') {
      return run;
    }
    const blockedRun = await patchRun(dependencies.store, runId, {
      status: 'blocked',
    });
    return blockedRun;
  }

  if (run.status === 'planning') {
    // startRun normally performs this transition. Reaching planning here means
    // the run was created but never dispatched; leave it for startRun.
    return run;
  }

  const work = workSteps(steps);
  const inFlight = work.some(
    (step) =>
      step.status === 'queued'
      || step.status === 'running'
      || step.status === 'waiting',
  );
  if (inFlight) {
    if (run.status !== 'running') {
      return patchRun(dependencies.store, runId, { status: 'running' });
    }
    return run;
  }

  // Every planned step in the current wave is done, and nothing is waiting
  // on the graph. The lead reads the digest and spawns, stops, or asks.
  if (work.length > 0 && work.every((step) => step.status === 'done')) {
    return maybeReviewWave(dependencies, run, steps);
  }

  if (run.status !== 'running') {
    return patchRun(dependencies.store, runId, { status: 'running' });
  }
  return run;
}

/**
 * Start a planned run (docs/TASKS.md, WP3).
 *
 * Behaviour:
 * 1. `planning -> running` with an optimistic run update.
 * 2. For each step that is not held by an open approval gate, enqueue one
 *    `createIssue` effect. The discriminator is fixed (`child-issue`), so a
 *    retried `startRun` cannot create a second Jira issue for the same step.
 *    A step that depends on an open gate does not get a child until that
 *    gate is approved. The gate's own child is created here so a person can
 *    transition it.
 * 3. Push `{runId, stepId, attempt}` to `step-queue` only for steps whose
 *    `dependsOn` list is already satisfied. The others move to `waiting`
 *    and start later, from `reportStep`, once those dependencies are `done`.
 *    An `approval` gate is the exception: it is stored as `waiting` even
 *    when nothing else is holding it, and it is not pushed. `approveGate`
 *    is what marks it `done`. The watchdog does not scan `waiting`.
 *
 * Calling `startRun` on a run that is already running or terminal is a no-op:
 * dispatch is idempotent and returns the current record. This also protects
 * `dispatch-run` retries from double-queueing every step.
 *
 * A run that is still `planning` does not leave that status unless
 * `overrides.confirmation` carries a human grant from `safety/grants.js`.
 * There is no flag that skips the check.
 *
 * @param {string} runId
 * @param {Partial<import('./dependencies.js').Wp3Dependencies> & {confirmation?: object}} [overrides]
 * @returns {Promise<import('../store/types.js').Run>}
 */
export async function startRun(runId, overrides) {
  const confirmation = overrides?.confirmation;
  const dependencies = resolveDependencies(overrides);
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new StoreValidationError('startRun runId is required');
  }

  return withLock(`run:${runId}`, async () => {
    const run = await requireRun(dependencies.store, runId);
    if (run.status !== 'planning') {
      return run;
    }

    const steps = await dependencies.store.listSteps(runId);
    // Reject a cycle or a dangling index before the run leaves `planning`.
    // `plan-split` already checks this; the second check covers a plan that
    // was written through the store directly.
    normalizePlanGraph(steps);
    // The blast-radius card is the list of Jira writes this plan's templates
    // will make. It is computed here, while the steps are still queued and
    // before `enqueueEffect` pushes a single `createIssue`. The function does
    // not call Jira and the card is not written to KVS. Callers receive it on
    // a copy of the run so a later `updateRun` cannot persist it as an
    // attribute. A second startRun returns above, while the run is no longer
    // `planning`, and does not rebuild the card.
    const blastRadius = previewBlastRadius({
      run,
      steps,
      planCard: planCardFromSteps(steps),
    });
    // Every caller, including fork and the unit harness, presents a grant.
    // A missing or reused token returns the planning run and enqueues
    // nothing. The card is on the return value only.
    const decision = await authorizeDispatchShared(
      confirmation,
      blastRadius,
      dependencies.now(),
      dependencies.store,
      run,
    );
    if (!decision.ok) {
      return { ...run, blastRadius, refusedConfirmation: decision };
    }
    const budgetStop = runBudgetStop(run.budget, dependencies.now(), run.createdAt);
    if (budgetStop) {
      const blockedRun = await applyBudgetStop(dependencies.store, run, budgetStop);
      return { ...blockedRun, blastRadius, budgetStopped: budgetStop.reason };
    }
    // Refresh elapsed on the write this transition already does. The
    // simulator clock is `dependencies.now`. No second KVS write.
    const runningRun = await patchRun(dependencies.store, runId, {
      status: 'running',
      budget: applyRunBudget(run.budget, {
        now: dependencies.now(),
        startedAt: run.createdAt,
      }),
    });

    // Wave 1 is the plan itself. The event is written once: a second
    // startRun returns above, while the run is no longer `planning`.
    if (steps.length > 0) {
      await recordEvent(dependencies.store, {
        runId,
        kind: 'wave_started',
        detail: {
          wave: 1,
          title: 'Wave 1',
          stepIdxs: steps.map((step) => step.idx),
          generator: 'fallback',
        },
      });
    }

    // Every sub-agent step gets a brief before its child issue is created,
    // so the issue description can show objective, tools, done-when, and
    // budget. A step that already has a brief (plan-split wrote one) is
    // left as it is.
    const briefed = [];
    for (const step of steps) {
      if (step.brief) {
        briefed.push(step);
        continue;
      }
      const prepared = briefForStep(step, runningRun);
      /** @type {Record<string, any>} */
      const patch = { brief: prepared.brief };
      if (prepared.skill) patch.skill = prepared.skill;
      briefed.push(await dependencies.store.updateStep(step.stepId, patch));
    }

    // Effects first, then step events. WP2's applier can create the child
    // issues while the ready step workers start. Both queues are at-least-once,
    // and every key is deterministic, so order only affects latency, not
    // correctness.
    // A fork marks the copied prefix `done` and only the downstream steps
    // stay `queued`. Skipping done steps keeps their child issues and their
    // journalled effects untouched. The briefed rows carry the same
    // dependsOn plus the sub-agent brief.
    const pending = briefed.filter((step) => step.status !== 'done');
    // Held steps wait for an open approval gate. Their child issue is
    // enqueued from `releaseWaitingSteps` after the gate is approved.
    const heldForApproval = stepIdsBlockedByOpenApproval(briefed);

    for (const step of pending) {
      if (heldForApproval.has(step.stepId)) continue;
      await dependencies.enqueueEffect({
        runId,
        stepId: step.stepId,
        kind: 'createIssue',
        payload: buildCreateIssuePayload(runningRun, step),
        discriminator: 'child-issue',
      });
    }

    // Ready steps are still `queued` and have not been pushed yet. Push
    // those. Steps with unmet dependsOn, and every approval gate, become
    // `waiting`. Done prefix steps from a fork are skipped.
    // dependenciesSatisfied still sees that prefix on `briefed`, so a
    // downstream step whose dependsOn indexes are done starts now. A gate
    // does not start, even when its own dependsOn is already done.
    for (const step of pending) {
      // A gate is not work the step worker can finish. Parking it as
      // `waiting` (the status `findStuckSteps` does not query) keeps the
      // watchdog from retrying it, including when its `dependsOn` is
      // already satisfied and a normal step would have been pushed.
      const held = isApprovalGate(step) || !dependenciesSatisfied(step, briefed);
      if (held) {
        await dependencies.store.updateStep(
          step.stepId,
          { status: 'waiting' },
          { expectedStatus: 'queued' },
        );
      } else {
        await pushStep(dependencies, runId, step);
      }
    }

    return { ...runningRun, blastRadius };
  });
}

/**
 * Start waiting steps whose dependencies are now all `done`.
 *
 * Only `waiting` rows are considered. A step that is already `queued` was
 * pushed at dispatch (or by an earlier release) and must not be pushed again:
 * the worker treats a second event for the same attempt as a duplicate.
 * An approval gate stays `waiting` until `approveGate`. A sibling finishing
 * must not push it just because its `dependsOn` list is empty.
 *
 * The status write uses the string compare-and-swap on `updateStep`. It does
 * not add a condition on a float field. `waiting` is not `queued`, so the
 * watchdog's "queued for 10 minutes" scan does not start a held step early.
 *
 * @param {object} dependencies Resolved WP3 dependencies.
 * @param {string} runId
 * @param {import('../store/types.js').Step[]} steps
 * @returns {Promise<void>}
 */
async function releaseWaitingSteps(dependencies, runId, steps) {
  /** @type {import('../store/types.js').Run|null} */
  let runForIssue = null;
  for (const step of steps) {
    if (step.status !== 'waiting' || isApprovalGate(step) || !dependenciesSatisfied(step, steps)) {
      continue;
    }
    // A gated step has no child yet. Create it now, unless the run is
    // already outside its budget. Steps that were issued a child at
    // dispatch already have `childIssueKey` once the effect has applied,
    // and this branch does not run for them.
    if (!step.childIssueKey) {
      if (!runForIssue) {
        runForIssue = await dependencies.store.getRun(runId);
      }
      if (!runForIssue) return;
      const budgetStop = runBudgetStop(
        runForIssue?.budget,
        dependencies.now(),
        runForIssue?.createdAt,
      );
      if (budgetStop) {
        await applyBudgetStop(dependencies.store, runForIssue, budgetStop);
        return;
      }
      await dependencies.enqueueEffect({
        runId,
        stepId: step.stepId,
        kind: 'createIssue',
        payload: buildCreateIssuePayload(runForIssue, step),
        discriminator: 'child-issue',
      });
    }
    const dependencyContext = dependencyContextFor(step, steps);
    const released = await dependencies.store.updateStep(
      step.stepId,
      {
        status: 'queued',
        dependencyContext,
        // A step can sit in `waiting` longer than the watchdog's 10 minute
        // queued threshold. A future deadline tells the watchdog this row was
        // just released. The worker replaces the deadline when it claims it.
        deadlineAt: dependencies.now() + STEP_DEADLINE_MS,
      },
      { expectedStatus: 'waiting' },
    );
    // Another invocation already released this step.
    if (!released) {
      continue;
    }
    await pushStep(dependencies, runId, released);
  }
}

/**
 * Push one step event. A failed push leaves the row `queued`; the watchdog
 * retries a queued step whose deadline has passed.
 *
 * @param {object} dependencies Resolved WP3 dependencies.
 * @param {string} runId
 * @param {import('../store/types.js').Step} step
 * @returns {Promise<void>}
 */
async function pushStep(dependencies, runId, step) {
  try {
    await dependencies.enqueueStep({
      runId,
      stepId: step.stepId,
      attempt: step.attempt,
    });
  } catch (error) {
    dependencies.logger.error(
      `WP10 could not enqueue step ${step.stepId}`,
      error,
    );
  }
}

/**
 * Record a step result and recompute the run (docs/TASKS.md, WP3).
 *
 * `status` is normally one of `done`, `failed`, or `blocked`; the other step
 * statuses are accepted so a trigger can report an in-progress state without a
 * separate API. Once a step is terminal, later reports are ignored (terminal
 * wins) so an at-least-once Jira trigger cannot flip a finished step.
 *
 * @param {string} stepId
 * @param {{status: import('../store/types.js').StepStatus, output?: any, error?: any}} report
 * @param {Partial<import('./dependencies.js').Wp3Dependencies>} [overrides]
 * @returns {Promise<{step: import('../store/types.js').Step, run: import('../store/types.js').Run}>}
 */
export async function reportStep(stepId, report, overrides) {
  const dependencies = resolveDependencies(overrides);
  // The worker's in-memory chat counter. `resolveDependencies` drops unknown
  // fields, so read it from the raw overrides. Empty when the model is off.
  const modelMeter = overrides?.modelMeter;
  if (typeof stepId !== 'string' || stepId.length === 0) {
    throw new StoreValidationError('reportStep stepId is required');
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new StoreValidationError('reportStep report must be an object');
  }
  if (!STEP_STATUSES.includes(report.status)) {
    throw new StoreValidationError(
      `reportStep status must be one of ${STEP_STATUSES.join(', ')}`,
    );
  }

  const initialStep = await dependencies.store.getStep(stepId);
  if (!initialStep) {
    throw new NotFoundError('step', stepId);
  }

  const initialStatus = initialStep.status;
  const outcome = await withLock(`run:${initialStep.runId}`, async () => {
    // Flush the worker's chats before any status write. The run lock
    // serialises parallel steps, so two meters cannot overwrite each other.
    // A zero meter (model off, or no chat) does not write.
    const calls = Number.isInteger(modelMeter?.calls) ? modelMeter.calls : 0;
    const tokens = Number.isInteger(modelMeter?.tokens) ? modelMeter.tokens : 0;
    if (calls > 0 || tokens > 0) {
      await commitRunBudget(
        dependencies.store,
        initialStep.runId,
        modelMeter,
        dependencies.now(),
      );
      modelMeter.calls = 0;
      modelMeter.tokens = 0;
    }
    const step = await dependencies.store.getStep(stepId);
    if (!step) {
      throw new NotFoundError('step', stepId);
    }

    // Terminal steps are immutable. A duplicate trigger is a no-op.
    if (
      step.status === 'done' ||
      step.status === 'failed' ||
      step.status === 'blocked'
    ) {
      const run = await recomputeRunStatusUnlocked(
        dependencies,
        step.runId,
      );
      return { step, run };
    }

    /** @type {Record<string, any>} */
    const patch = { status: report.status };
    if (Object.prototype.hasOwnProperty.call(report, 'output')) {
      patch.output = report.output;
    }
    if (Object.prototype.hasOwnProperty.call(report, 'error')) {
      patch.error = report.error;
    } else if (report.status === 'done') {
      // Clear an error left by an earlier running report.
      patch.error = undefined;
    }

    const updatedStep = await dependencies.store.updateStep(stepId, patch);
    // A finished step may be the last dependency of one or more waiting
    // steps. Release those before recomputing the run, so the run is not
    // marked done while work is still held. A failed or blocked step does
    // not release anything; the run becomes blocked and the dependents stay
    // `waiting`.
    if (updatedStep.status === 'done') {
      const steps = await dependencies.store.listSteps(updatedStep.runId);
      await releaseWaitingSteps(dependencies, updatedStep.runId, steps);
    }
    if (
      updatedStep.status === 'done'
      || updatedStep.status === 'failed'
      || updatedStep.status === 'blocked'
    ) {
      const succeeded = updatedStep.status === 'done';
      const outputRecord = report.output && typeof report.output === 'object'
        ? report.output
        : null;
      await recordEvent(dependencies.store, {
        runId: updatedStep.runId,
        kind: succeeded ? 'step.succeeded' : 'step.failed',
        stepId: updatedStep.stepId,
        stepIdx: updatedStep.idx,
        journalKey: succeeded
          ? stepResultKey({
            runId: updatedStep.runId,
            stepId: updatedStep.stepId,
            attempt: updatedStep.attempt,
          })
          : undefined,
        detail: {
          title: updatedStep.title,
          workerType: updatedStep.workerType,
          skill: updatedStep.skill || null,
          attempt: updatedStep.attempt,
          status: updatedStep.status,
          generator: outputRecord?.generator,
          model: outputRecord?.generator === 'llm' ? outputRecord.model : null,
          output: succeeded ? compactDetail(report.output) : undefined,
          error: report.error,
        },
      });
    }
    const run = await recomputeRunStatusUnlocked(
      dependencies,
      updatedStep.runId,
    );
    return { step: updatedStep, run };
  });

  // A failed or blocked step becomes a proposed lesson. A duplicate report
  // (the step was already terminal) does not write a second one. The lesson
  // write is not allowed to fail the status update.
  if (
    (report.status === 'failed' || report.status === 'blocked') &&
    initialStatus !== 'done' &&
    initialStatus !== 'failed' &&
    initialStatus !== 'blocked' &&
    outcome?.step?.status === report.status
  ) {
    try {
      const { recordFailureLesson } = await import('../memory/lessons.js');
      await recordFailureLesson({
        store: dependencies.store,
        run: outcome.run,
        step: outcome.step,
        status: report.status,
        error: report.error ?? outcome.step.error,
        kind: report.status === 'blocked' ? 'step-blocked' : 'step-failed',
      });
    } catch {
      // The step result is already stored.
    }
  }
  return outcome;
}

/**
 * Recompute a run from its current steps (docs/TASKS.md, WP3).
 *
 * - any `failed`/`blocked` step -> run `blocked`;
 * - all steps `done` -> run `done` and append one `summarize` step;
 * - otherwise the run remains/stays `running`.
 *
 * @param {string} runId
 * @param {Partial<import('./dependencies.js').Wp3Dependencies>} [overrides]
 * @returns {Promise<import('../store/types.js').Run>}
 */
export async function recomputeRunStatus(runId, overrides) {
  const dependencies = resolveDependencies(overrides);
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new StoreValidationError('recomputeRunStatus runId is required');
  }
  return withLock(`run:${runId}`, () =>
    recomputeRunStatusUnlocked(dependencies, runId),
  );
}

/**
 * Deadline used when a worker claims a step. Exported for WP4 and for tests.
 *
 * @param {number} startedAt
 * @returns {number}
 */
export function deadlineFor(startedAt) {
  return startedAt + STEP_DEADLINE_MS;
}
