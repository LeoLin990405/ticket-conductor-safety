/**
 * Approval gates as DAG nodes.
 *
 * The gate is a normal step. `startRun` creates its child issue and leaves
 * the step `waiting`. A sibling with no dependency is pushed. A step that
 * lists the gate in `dependsOn` stays `waiting` until `approveGate`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { resetStore, setStore } from '../../store/index.js';
import { resetWorkerTypes, stepWorkerHandler } from '../../worker/index.js';
import { resetLocks } from '../locks.js';
import { approveGate } from '../approval.js';
import { reportStep, startRun } from '../stateMachine.js';

import { createHarness } from './harness.js';

test.afterEach(() => {
  resetWorkerTypes();
  resetLocks();
  resetStore();
});

test('a sibling runs while the gate and its dependent stay waiting', async () => {
  const harness = createHarness();
  const run = await harness.createRun();
  const steps = await harness.createSteps(run.runId, [
    { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
    { title: 'Approve the refund spec', workerType: 'approval', input: {}, dependsOn: [] },
    { title: 'Draft the refund spec', workerType: 'draft-spec', input: 'spec', dependsOn: [1] },
  ]);

  await startRun(run.runId, harness.dependencies);

  assert.deepEqual(
    harness.stepEvents.map((event) => event.stepId),
    [steps[0].stepId],
  );
  assert.equal(
    harness.enqueuedEffects.filter((effect) => effect.kind === 'createIssue').length,
    2,
  );
  assert.deepEqual(
    harness.enqueuedEffects
      .filter((effect) => effect.kind === 'createIssue')
      .map((effect) => effect.stepId)
      .sort(),
    [steps[0].stepId, steps[1].stepId].sort(),
  );
  const parked = await harness.store.getStep(steps[1].stepId);
  const draft = await harness.store.getStep(steps[2].stepId);
  assert.equal(parked.status, 'waiting');
  assert.equal(parked.attempt, 0);
  assert.equal(draft.status, 'waiting');
  assert.equal(draft.attempt, 0);

  await reportStep(
    steps[0].stepId,
    { status: 'done', output: { summary: 'refunds' } },
    harness.dependencies,
  );
  assert.equal(harness.stepEvents.length, 1);
  assert.equal((await harness.store.getStep(steps[1].stepId)).status, 'waiting');
  assert.equal((await harness.store.getStep(steps[2].stepId)).status, 'waiting');

  const approved = await approveGate(
    steps[1].stepId,
    { actor: 'manager-1', note: 'ship it' },
    harness.dependencies,
  );
  assert.equal(approved.approved, true);
  assert.equal(approved.duplicate, false);
  assert.equal(approved.step.output.actor, 'manager-1');
  assert.equal(harness.stepEvents.length, 2);
  assert.equal(harness.stepEvents[1].stepId, steps[2].stepId);
  assert.equal(
    harness.enqueuedEffects.filter((effect) => effect.kind === 'createIssue' && effect.stepId === steps[2].stepId).length,
    1,
  );
  const released = await harness.store.getStep(steps[2].stepId);
  assert.equal(released.status, 'queued');
  assert.equal(released.dependencyContext[0].workerType, 'approval');
  assert.equal(released.dependencyContext[0].output.approved, true);

  const again = await approveGate(steps[1].stepId, { actor: 'manager-1' }, harness.dependencies);
  assert.equal(again.duplicate, true);
  assert.equal(harness.stepEvents.length, 2);
});

test('a queued approval event is parked and does not enqueue a comment', async () => {
  const harness = createHarness();
  setStore(harness.store);
  const run = await harness.createRun();
  const [gate] = await harness.createSteps(run.runId, [
    { title: 'Approve blast radius', workerType: 'approval', input: {}, dependsOn: [] },
  ]);
  const before = harness.enqueuedEffects.length;
  const result = await stepWorkerHandler({
    runId: run.runId,
    stepId: gate.stepId,
    attempt: 0,
  }, harness.dependencies);
  assert.equal(result.status, 'parked');
  assert.equal(result.reason, 'awaiting-approval');
  assert.equal((await harness.store.getStep(gate.stepId)).status, 'waiting');
  assert.equal(harness.enqueuedEffects.length, before);
});
