/**
 * Unit tests for the run state machine transitions that are awkward to reach
 * through the queue alone (direct `reportStep`, explicit recomputation, and
 * terminal-step idempotency).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { StoreValidationError } from '../../store/index.js';
import { resetLocks } from '../locks.js';
import {
  recomputeRunStatus,
  ensureSummarizeStep,
  reportStep,
  startRun,
} from '../stateMachine.js';
import { resetWorkerTypes } from '../../worker/index.js';

import { createHarness } from './harness.js';

test.afterEach(() => {
  resetWorkerTypes();
  resetLocks();
});

test('reportStep moves running -> done and appends exactly one summarize step', async () => {
  const harness = createHarness();
  const run = await harness.createRun();
  const [first, second] = await harness.createSteps(run.runId, [
    { title: 'One', workerType: 'draft-spec', input: {} },
    { title: 'Two', workerType: 'research', input: {} },
  ]);
  await startRun(run.runId, harness.dependencies);

  const afterFirst = await reportStep(
    first.stepId,
    { status: 'done', output: { summary: 'first done' } },
    harness.dependencies,
  );
  assert.equal(afterFirst.step.status, 'done');
  assert.equal(afterFirst.run.status, 'running');

  const afterSecond = await reportStep(
    second.stepId,
    { status: 'done', output: { summary: 'second done' } },
    harness.dependencies,
  );
  assert.equal(afterSecond.run.status, 'done');

  const steps = await harness.store.listSteps(run.runId);
  assert.equal(steps.length, 3);
  assert.equal(steps.filter((step) => step.workerType === 'summarize').length, 1);

  // A duplicate terminal report is a no-op.
  const duplicate = await reportStep(
    first.stepId,
    { status: 'failed', error: { message: 'late failure' } },
    harness.dependencies,
  );
  assert.equal(duplicate.step.status, 'done');
  assert.equal(duplicate.step.error, undefined);
  assert.equal(duplicate.run.status, 'done');
  assert.equal((await harness.store.listSteps(run.runId)).length, 3);
});

test('recomputeRunStatus blocks the run when any step failed', async () => {
  const harness = createHarness();
  const run = await harness.createRun();
  const [first] = await harness.createSteps(run.runId, [
    { title: 'One', workerType: 'draft-spec', input: {} },
    { title: 'Two', workerType: 'research', input: {} },
  ]);
  await startRun(run.runId, harness.dependencies);

  await harness.store.updateStep(first.stepId, {
    status: 'failed',
    error: { message: 'nope' },
  });
  const blocked = await recomputeRunStatus(run.runId, harness.dependencies);
  assert.equal(blocked.status, 'blocked');
  assert.equal((await harness.store.getRun(run.runId)).status, 'blocked');
});

test('startRun leaves terminal and already-running runs untouched', async () => {
  const harness = createHarness();
  const run = await harness.createRun();
  const [step] = await harness.createSteps(run.runId, [
    { title: 'One', workerType: 'draft-spec', input: {} },
  ]);
  await startRun(run.runId, harness.dependencies);
  await harness.store.updateStep(step.stepId, { status: 'done' });
  await harness.store.updateRun(run.runId, { status: 'done' });

  const stepEventsBefore = harness.stepEvents.length;
  const returned = await startRun(run.runId, harness.dependencies);
  assert.equal(returned.status, 'done');
  assert.equal(harness.stepEvents.length, stepEventsBefore);
});

test('reportStep validates its input and unknown ids', async () => {
  const harness = createHarness();
  await assert.rejects(
    () =>
      reportStep(
        '00000000-0000-4000-8000-000000000000',
        { status: 'done' },
        harness.dependencies,
      ),
    /not found/i,
  );

  const run = await harness.createRun();
  const [step] = await harness.createSteps(run.runId, [
    { title: 'One', workerType: 'draft-spec', input: {} },
  ]);
  await assert.rejects(
    () => reportStep(step.stepId, { status: 'nonsense' }, harness.dependencies),
    StoreValidationError,
  );
});

// Regression (run b2d944c7): two steps finished in separate Forge invocations,
// so the in-process run lock did not serialize them. Both saw a step list with
// no summarize step and both appended one.
test('concurrent completions append only one summarize step', async () => {
  const harness = createHarness();
  const run = await harness.createRun();
  const steps = await harness.createSteps(run.runId, [
    { title: 'One', workerType: 'research', input: {} },
    { title: 'Two', workerType: 'draft-spec', input: {} },
  ]);
  const fresh = await harness.store.getRun(run.runId);
  // Same stale snapshot in both "invocations", run concurrently without the lock.
  const results = await Promise.all([
    ensureSummarizeStep(harness.dependencies, fresh, steps),
    ensureSummarizeStep(harness.dependencies, fresh, steps),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  const all = await harness.store.listSteps(run.runId);
  assert.equal(all.filter((step) => step.workerType === 'summarize').length, 1);
});

test('startRun pushes the remaining steps when one step push is refused', async () => {
  const harness = createHarness();
  const run = await harness.createRun();
  await harness.createSteps(run.runId, [
    { title: 'One', workerType: 'draft-spec', input: {} },
    { title: 'Two', workerType: 'research', input: {} },
  ]);
  const pushed = [];
  let calls = 0;
  const dependencies = {
    ...harness.dependencies,
    async enqueueStep(payload) {
      calls += 1;
      if (calls === 1) throw new Error('400 Bad Request');
      pushed.push(payload);
    },
  };
  const started = await startRun(run.runId, dependencies);
  assert.equal(started.status, 'running');
  assert.equal(calls, 2);
  assert.equal(pushed.length, 1);
});
