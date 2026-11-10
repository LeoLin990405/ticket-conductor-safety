/**
 * Fork a run from step N.
 *
 * DBOS `forkWorkflow` and LangGraph checkpoint resume both keep the journal
 * up to a step and execute only what comes after it. Ticket Conductor copies
 * the flight-recorder events for the prefix onto a new run, marks those steps
 * `done` with the original output and child issue, and does not enqueue their
 * effects. The copied events keep the original `journalKey` (the effect
 * requestKey or the step-result key), so a later replay looks the result up
 * instead of writing to Jira again.
 *
 * Two cut rules:
 * - No input edit: copy events for steps up to and including N, re-run only
 *   strict downstream steps.
 * - Input edit: step N's input is replaced, N is re-run together with its
 *   downstream steps, and the copied log stops before N.
 *
 * Downstream is linear (higher idx) unless a step carries `dependsOn` or
 * `input.dependsOn`. The new run stores `forkedFromRunId` and
 * `forkedFromStepIdx`. The original run gains one `run.forked` event and is
 * otherwise unchanged: its steps and effects are not rewritten.
 *
 * @module recorder/fork
 */

import { ensureSummarizeStep, startRun } from '../run/stateMachine.js';
import { resolveDependencies } from '../run/dependencies.js';
import { NotFoundError, StoreValidationError } from '../store/index.js';
import { selectForkSets } from './graph.js';
import { recordEvent } from './log.js';
import { stableStringify } from './stable.js';

/**
 * Accept a string from a Rovo action. A JSON object or array is parsed so a
 * caller can replace a structured step input. Plain text stays a string.
 *
 * @param {unknown} input
 * @returns {unknown}
 */
export function parseForkInput(input) {
  if (typeof input !== 'string') {
    return input;
  }
  const trimmed = input.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return input;
    }
  }
  return input;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function requireIdx(value) {
  const idx = typeof value === 'string' && value.trim() !== ''
    ? Number(value)
    : value;
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
    throw new StoreValidationError('fork stepIdx must be a non-negative integer');
  }
  return idx;
}

/**
 * @param {{
 *   runId: string,
 *   stepIdx: number|string,
 *   input?: unknown,
 *   createdBy?: string,
 * }} input
 * @param {object} [overrides] Passed through to `startRun` (store, queues, clock).
 * @returns {Promise<object>}
 */
export async function forkRun(input, overrides = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const runId = typeof source.runId === 'string' ? source.runId : '';
  if (!runId) {
    throw new StoreValidationError('fork runId is required');
  }
  const stepIdx = requireIdx(source.stepIdx);
  const dependencies = resolveDependencies(overrides);
  const store = dependencies.store;
  const run = await store.getRun(runId);
  if (!run) {
    throw new NotFoundError('run', runId);
  }
  const steps = await store.listSteps(runId);
  const anchor = steps.find((step) => step.idx === stepIdx);
  if (!anchor || anchor.workerType === 'summarize') {
    throw new StoreValidationError(
      `fork stepIdx ${stepIdx} is not a step on run ${runId}`,
    );
  }

  const parsedInput = Object.prototype.hasOwnProperty.call(source, 'input')
    && source.input !== undefined
    && source.input !== null
    ? parseForkInput(source.input)
    : undefined;
  const edited = parsedInput !== undefined
    && stableStringify(parsedInput) !== stableStringify(anchor.input ?? '');
  const sets = selectForkSets(steps, stepIdx, { edited });
  const copyIdx = new Set(sets.copy);

  const sources = steps
    .filter((step) => step.workerType !== 'summarize')
    .sort((left, right) => left.idx - right.idx);

  const events = typeof store.listEventsByRun === 'function'
    ? await store.listEventsByRun(runId)
    : [];
  const copiedStepEvents = events.filter(
    (event) => typeof event.stepIdx === 'number' && copyIdx.has(event.stepIdx),
  );
  const maxSeq = copiedStepEvents.reduce(
    (max, event) => Math.max(max, event.seq ?? 0),
    -1,
  );
  const prefix = events
    .filter((event) => {
      if (event.kind === 'run.forked') {
        return false;
      }
      if (typeof event.stepIdx === 'number') {
        return copyIdx.has(event.stepIdx);
      }
      return maxSeq >= 0 && event.seq <= maxSeq;
    })
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));

  const forkSeq = maxSeq >= 0 ? maxSeq : undefined;
  const createdBy = typeof source.createdBy === 'string' && source.createdBy.length > 0
    ? source.createdBy
    : run.createdBy;
  const forked = await store.createRun({
    epicKey: run.epicKey,
    projectKey: run.projectKey,
    goal: run.goal,
    createdBy,
    forkedFromRunId: run.runId,
    forkedFromStepIdx: stepIdx,
    ...(forkSeq === undefined ? {} : { forkSeq }),
  });

  const drafts = sources.map((step) => ({
    title: step.title,
    workerType: step.workerType,
    input: edited && step.idx === stepIdx ? parsedInput : step.input,
    // Keep the WP10 edges. Downstream steps stay `waiting` until the copied
    // prefix (status `done`) satisfies `dependsOn`.
    dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn : [],
  }));
  const created = await store.createSteps(forked.runId, drafts);
  /** @type {Map<number, string>} */
  const newStepIdByIdx = new Map();
  for (let index = 0; index < created.length; index += 1) {
    const step = created[index];
    const original = sources[index];
    newStepIdByIdx.set(original.idx, step.stepId);
    if (!copyIdx.has(original.idx)) {
      continue;
    }
    await store.updateStep(step.stepId, {
      status: 'done',
      attempt: original.attempt ?? 0,
      output: original.output,
      childIssueKey: original.childIssueKey,
      stallCount: original.stallCount,
      error: undefined,
    });
  }

  for (const event of prefix) {
    const remappedStepId = typeof event.stepIdx === 'number'
      ? newStepIdByIdx.get(event.stepIdx)
      : undefined;
    await store.appendEvent({
      runId: forked.runId,
      kind: event.kind,
      at: event.at,
      stepIdx: event.stepIdx,
      stepId: remappedStepId,
      journalKey: event.journalKey,
      span: event.span,
      detail: {
        ...(event.detail && typeof event.detail === 'object' ? event.detail : {}),
        copiedFromRunId: run.runId,
        copiedFromSeq: event.seq,
      },
    });
  }

  await recordEvent(store, {
    runId: forked.runId,
    kind: 'run.forked',
    stepIdx,
    detail: {
      forkedFromRunId: run.runId,
      stepIdx,
      edited,
      mode: sets.mode,
      copiedEvents: prefix.length,
      rerun: sets.rerun,
    },
  });
  await recordEvent(store, {
    runId: run.runId,
    kind: 'run.forked',
    stepIdx,
    detail: {
      forkedRunId: forked.runId,
      stepIdx,
      edited,
      mode: sets.mode,
    },
  });

  const fresh = await store.listSteps(forked.runId);
  for (const step of fresh) {
    if (step.status !== 'queued') {
      continue;
    }
    await recordEvent(store, {
      runId: forked.runId,
      kind: 'step.queued',
      stepId: step.stepId,
      stepIdx: step.idx,
      detail: {
        title: step.title,
        workerType: step.workerType,
        forked: true,
      },
    });
  }

  const pending = fresh.some((step) => step.status !== 'done');
  let started;
  if (pending) {
    // startRun enqueues createIssue and step-queue only for steps that are
    // not already done, so the copied prefix does not write to Jira.
    started = await startRun(forked.runId, overrides);
  } else {
    started = await store.updateRun(forked.runId, { status: 'done' });
    await ensureSummarizeStep(
      resolveDependencies({ ...overrides, store }),
      started,
      fresh,
    );
  }

  return {
    ok: true,
    runId: started.runId,
    status: started.status,
    forkedFromRunId: run.runId,
    forkedFromStepIdx: stepIdx,
    edited,
    mode: sets.mode,
    copiedEvents: prefix.length,
    copy: sets.copy,
    rerun: sets.rerun,
  };
}
