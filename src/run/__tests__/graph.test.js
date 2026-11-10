/**
 * Plan graph checks and the runtime gate that honours them (WP10).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { StoreValidationError } from '../../store/index.js';
import { resetLocks } from '../locks.js';
import {
  dependenciesSatisfied,
  dependencyContextFor,
  normalizePlanGraph,
} from '../graph.js';
import { reportStep, startRun } from '../stateMachine.js';
import { registerWorkerType, resetWorkerTypes } from '../../worker/index.js';

import { createHarness } from './harness.js';

test.afterEach(() => {
  resetWorkerTypes();
  resetLocks();
});

test('normalizePlanGraph accepts a chain and parallel branches', () => {
  const chain = normalizePlanGraph([
    { title: 'Research', dependsOn: [] },
    { title: 'Draft', dependsOn: [0] },
    { title: 'Check', dependsOn: [1] },
  ]);
  assert.deepEqual(chain.map((step) => step.dependsOn), [[], [0], [1]]);

  const parallel = normalizePlanGraph([
    { idx: 0, dependsOn: [] },
    { idx: 1, dependsOn: [] },
    { idx: 2, dependsOn: [0, 1] },
  ]);
  assert.deepEqual(parallel[2].dependsOn, [0, 1]);
  assert.equal(dependenciesSatisfied(parallel[2], [
    { idx: 0, status: 'done' },
    { idx: 1, status: 'queued' },
  ]), false);
  assert.equal(dependenciesSatisfied({ dependsOn: [] }, []), true);
});

test('normalizePlanGraph rejects cycles, self-indexes, and unknown indexes', () => {
  assert.throws(
    () => normalizePlanGraph([
      { dependsOn: [1] },
      { dependsOn: [0] },
    ]),
    (error) => {
      assert.ok(error instanceof StoreValidationError);
      assert.match(error.message, /cycle: 0 -> 1 -> 0/);
      return true;
    },
  );
  assert.throws(
    () => normalizePlanGraph([{ dependsOn: [0] }]),
    /cannot include its own index/,
  );
  assert.throws(
    () => normalizePlanGraph([{ dependsOn: [3] }]),
    /references 3/,
  );
  assert.throws(
    () => normalizePlanGraph([{ dependsOn: [0, 0] }]),
    /more than once/,
  );
  assert.throws(
    () => normalizePlanGraph([{ dependsOn: '0' }]),
    /must be an array/,
  );
});

test('dependencyContextFor keeps outputs and shrinks an oversized copy', () => {
  const steps = [
    { idx: 0, title: 'Research', workerType: 'research', output: { summary: 'found' } },
    { idx: 1, title: 'Other', workerType: 'research', output: { summary: 'also' } },
  ];
  const context = dependencyContextFor({ dependsOn: [0, 1] }, steps);
  assert.equal(context[0].output.summary, 'found');
  assert.equal(context[1].title, 'Other');

  const huge = dependencyContextFor(
    { dependsOn: [0] },
    [{ idx: 0, title: 'Research', workerType: 'research', output: { blob: 'x'.repeat(60_000) } }],
    2000,
  );
  assert.equal(huge[0].truncated, true);
  assert.equal(typeof huge[0].output, 'string');
});

test('startRun enqueues independent steps and holds the step that depends on them', async () => {
  const harness = createHarness();
  const run = await harness.createRun();
  const steps = await harness.createSteps(run.runId, [
    { title: 'Research refunds', workerType: 'research', input: {}, dependsOn: [] },
    { title: 'Research ledger', workerType: 'research', input: {}, dependsOn: [] },
    { title: 'Draft the spec', workerType: 'draft-spec', input: {}, dependsOn: [0, 1] },
    { title: 'Check dependencies', workerType: 'check-deps', input: {}, dependsOn: [2] },
  ]);

  await startRun(run.runId, harness.dependencies);

  assert.deepEqual(
    harness.stepEvents.map((event) => event.stepId),
    [steps[0].stepId, steps[1].stepId],
  );
  const stored = await harness.store.listSteps(run.runId);
  assert.equal(stored[2].status, 'waiting');
  assert.equal(stored[3].status, 'waiting');
  assert.equal(
    harness.enqueuedEffects.filter((effect) => effect.kind === 'createIssue').length,
    4,
  );

  await reportStep(
    steps[0].stepId,
    { status: 'done', output: { summary: 'refunds' } },
    harness.dependencies,
  );
  assert.equal(harness.stepEvents.length, 2);
  assert.equal((await harness.store.getStep(steps[2].stepId)).status, 'waiting');

  await reportStep(
    steps[1].stepId,
    { status: 'done', output: { summary: 'ledger' } },
    harness.dependencies,
  );
  assert.equal(harness.stepEvents.length, 3);
  assert.equal(harness.stepEvents[2].stepId, steps[2].stepId);
  const draft = await harness.store.getStep(steps[2].stepId);
  assert.equal(draft.status, 'queued');
  assert.deepEqual(
    draft.dependencyContext.map((entry) => entry.output.summary),
    ['refunds', 'ledger'],
  );
  assert.equal((await harness.store.getStep(steps[3].stepId)).status, 'waiting');
});

test('a failed dependency does not start the step that waits on it', async () => {
  const harness = createHarness();
  const run = await harness.createRun();
  const [first, second] = await harness.createSteps(run.runId, [
    { title: 'Research', workerType: 'research', input: {} },
    { title: 'Draft', workerType: 'draft-spec', input: {}, dependsOn: [0] },
  ]);
  await startRun(run.runId, harness.dependencies);
  const reported = await reportStep(
    first.stepId,
    { status: 'failed', error: { message: 'nope' } },
    harness.dependencies,
  );
  assert.equal(reported.run.status, 'blocked');
  assert.equal((await harness.store.getStep(second.stepId)).status, 'waiting');
  assert.equal(harness.stepEvents.length, 1);
});

test('startRun rejects a stored cycle and leaves the run in planning', async () => {
  const harness = createHarness();
  const run = await harness.createRun();
  await harness.createSteps(run.runId, [
    { title: 'A', workerType: 'research', input: {}, dependsOn: [1] },
    { title: 'B', workerType: 'draft-spec', input: {}, dependsOn: [0] },
  ]);
  await assert.rejects(
    () => startRun(run.runId, harness.dependencies),
    /cycle/,
  );
  assert.equal((await harness.store.getRun(run.runId)).status, 'planning');
  assert.equal(harness.stepEvents.length, 0);
});

test('the worker receives dependency outputs on the step it is given', async () => {
  const harness = createHarness();
  let seen;
  registerWorkerType('capture', async (step) => {
    seen = step.dependencyContext;
    return { output: { ok: true }, effects: [] };
  });
  const run = await harness.createRun();
  await harness.createSteps(run.runId, [
    { title: 'Research refunds', workerType: 'research', input: {} },
    { title: 'Capture', workerType: 'capture', input: {}, dependsOn: [0] },
  ]);
  await startRun(run.runId, harness.dependencies);
  assert.equal(harness.stepEvents.length, 1);

  await harness.processAll();

  assert.ok(Array.isArray(seen));
  assert.equal(seen[0].idx, 0);
  assert.equal(seen[0].workerType, 'research');
  assert.equal(typeof seen[0].output.summary, 'string');
  const steps = await harness.store.listSteps(run.runId);
  assert.ok(steps.filter((step) => step.workerType !== 'summarize').every((step) => step.status === 'done'));
});
