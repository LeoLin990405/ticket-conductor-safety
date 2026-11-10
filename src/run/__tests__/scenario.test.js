/**
 * Acceptance scenario tests for WP3 (docs/TASKS.md).
 *
 * These use the real state machine, real worker registry, and the WP1 memory
 * adapter. WP2 is represented by the harness stub because `src/effects/` is
 * built on a parallel branch.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { resetLocks } from '../locks.js';
import { startRun } from '../stateMachine.js';
import {
  registerWorkerType,
  resetWorkerTypes,
  stepWorkerHandler,
} from '../../worker/index.js';

import { createHarness } from './harness.js';

test.afterEach(() => {
  resetWorkerTypes();
  resetLocks();
});

test('scenario: a four-step run reaches done and produces the Epic summary', async () => {
  const harness = createHarness();
  const run = await harness.createRun();
  await harness.createSteps(run.runId, [
    { title: 'Research refunds', workerType: 'research', input: {} },
    {
      title: 'Draft refund spec',
      workerType: 'draft-spec',
      input: { description: 'Add refund API.', acceptanceCriteria: ['Refunds work'] },
    },
    { title: 'Check dependencies', workerType: 'check-deps', input: {} },
    { title: 'Research competitors', workerType: 'research', input: {} },
  ]);

  const startedRun = await startRun(run.runId, harness.dependencies);
  assert.equal(startedRun.status, 'running');
  assert.equal(harness.stepEvents.length, 4);

  // Exactly one deterministic createIssue effect per step, with the contract's
  // payload fields (WP2 applies these to Jira).
  const createEffects = harness.enqueuedEffects.filter(
    (effect) => effect.kind === 'createIssue',
  );
  assert.equal(createEffects.length, 4);
  const planned = await harness.store.listSteps(run.runId);
  assert.equal(createEffects[0].stepId, planned[0].stepId);
  assert.equal(createEffects[0].runId, run.runId);
  assert.equal(createEffects[0].kind, 'createIssue');
  assert.equal(createEffects[0].discriminator, 'child-issue');
  assert.equal(createEffects[0].payload.projectKey, 'TC');
  assert.equal(createEffects[0].payload.parentKey, 'TC-1');
  assert.equal(createEffects[0].payload.summary, 'Research refunds');
  assert.equal(createEffects[0].payload.issueType, 'Sub-task');
  assert.match(
    createEffects[0].payload.description,
    /^Goal: Ship payment refunds\n\nStep: Research refunds/,
  );
  assert.match(createEffects[0].payload.description, /Done when:/);
  assert.match(createEffects[0].payload.description, /Allowed tools: searchIssues/);

  // Dispatch is idempotent: a second startRun must not queue the steps twice.
  const secondStart = await startRun(run.runId, harness.dependencies);
  assert.equal(secondStart.status, 'running');
  assert.equal(harness.stepEvents.length, 4);

  const results = await harness.processAll();
  assert.equal(results.filter((result) => result.status === 'done').length, 5);

  const finalRun = await harness.store.getRun(run.runId);
  assert.equal(finalRun.status, 'done');
  assert.match(String(finalRun.summary), /completed 4 step\(s\)/);

  const steps = await harness.store.listSteps(run.runId);
  assert.equal(steps.length, 5, 'four planned steps plus the automatic summary');
  assert.ok(steps.every((step) => step.status === 'done'));
  assert.ok(
    steps.every((step) => typeof step.deadlineAt === 'number'),
    'each worker sets deadlineAt when it claims the step',
  );
  assert.ok(
    steps.every((step) => step.deadlineAt === harness.now + 12 * 60 * 1000),
  );

  const summarizeStep = steps.find((step) => step.workerType === 'summarize');
  assert.ok(summarizeStep);
  assert.equal(summarizeStep.input.auto, true);

  // WP6 writeBack is the only owner of the Epic memory comment.
  const memoryEffects = harness.enqueuedEffects.filter(
    (effect) =>
      effect.kind === 'comment' &&
      effect.payload.issueKey === 'TC-1' &&
      typeof effect.payload.bodyText === 'string' &&
      effect.payload.bodyText.startsWith('[Conductor memory]'),
  );
  assert.equal(memoryEffects.length, 1);
  assert.equal(memoryEffects[0].discriminator, 'memory:epic-comment');
  assert.match(memoryEffects[0].payload.bodyText, /Draft refund spec|completed 4/);
});

test('scenario: a failed step blocks the run and the failing worker is recorded', async () => {
  const harness = createHarness();
  const run = await harness.createRun();
  await harness.createSteps(run.runId, [
    { title: 'Draft the plan', workerType: 'draft-spec', input: {} },
    { title: 'Explode', workerType: 'boom', input: {} },
  ]);

  registerWorkerType('boom', async () => {
    throw new Error('worker exploded');
  });

  await startRun(run.runId, harness.dependencies);
  const results = await harness.processAll();

  const failed = results.find((result) => result.status === 'failed');
  assert.ok(failed);
  assert.equal(failed.error.message, 'worker exploded');

  const finalRun = await harness.store.getRun(run.runId);
  assert.equal(finalRun.status, 'blocked');

  const steps = await harness.store.listSteps(run.runId);
  assert.equal(steps.length, 2, 'no summarize step is added to a blocked run');
  const boomStep = steps.find((step) => step.workerType === 'boom');
  assert.equal(boomStep.status, 'failed');
  assert.equal(boomStep.error.message, 'worker exploded');
});

test('scenario: a duplicate step event is a no-op', async () => {
  const harness = createHarness();
  let calls = 0;
  registerWorkerType('counted', async () => {
    calls += 1;
    return {
      output: { summary: 'counted once' },
      effects: [
        {
          kind: 'comment',
          payload: { issueKey: 'TC-1', bodyText: 'only once' },
          discriminator: 'counted-comment',
        },
      ],
    };
  });

  const run = await harness.createRun();
  await harness.createSteps(run.runId, [
    { title: 'Count me', workerType: 'counted', input: {} },
  ]);
  await startRun(run.runId, harness.dependencies);

  const [event] = harness.stepEvents;
  const first = await stepWorkerHandler({ body: event }, harness.dependencies);
  assert.equal(first.status, 'done');
  assert.equal(calls, 1);

  const effectsAfterFirst = harness.enqueuedEffects.length;
  const second = await stepWorkerHandler(event, harness.dependencies);
  assert.equal(second.status, 'duplicate');
  assert.equal(calls, 1, 'the worker handler must not run twice');
  assert.equal(
    harness.enqueuedEffects.length,
    effectsAfterFirst,
    'duplicate delivery must not emit effects',
  );

  const steps = await harness.store.listSteps(run.runId);
  assert.equal(steps[0].status, 'done');
  assert.equal(steps[0].output.summary, 'counted once');
});

test('stale attempt exits before running the worker or emitting effects', async () => {
  const harness = createHarness();
  let calls = 0;
  registerWorkerType('counted', async () => {
    calls += 1;
    return { output: {} };
  });

  const run = await harness.createRun();
  const [step] = await harness.createSteps(run.runId, [
    { title: 'Count me', workerType: 'counted', input: {} },
  ]);
  await startRun(run.runId, harness.dependencies);

  // Simulate the watchdog incrementing the attempt before this older event is
  // delivered. The event still says attempt 0.
  await harness.store.updateStep(step.stepId, { attempt: 1 });

  const result = await harness.processNext();
  assert.equal(result.status, 'stale');
  assert.equal(calls, 0);
  assert.equal(harness.enqueuedEffects.filter((e) => e.kind === 'comment').length, 0);
});

test('two comments for one child are enqueued as one effect and the transition stays', async () => {
  const harness = createHarness();
  registerWorkerType('note-pair', async (step) => {
    const target = step.childIssueKey
      ? { issueKey: step.childIssueKey }
      : { childOfStepId: step.stepId };
    return {
      output: { summary: 'paired notes for the refund spec' },
      effects: [
        {
          kind: 'comment',
          discriminator: 'worker-output',
          payload: { ...target, bodyText: 'WORKER-OUTPUT the refund notes' },
        },
        {
          kind: 'comment',
          discriminator: 'status-note',
          payload: { ...target, bodyText: 'STATUS-NOTE the step finished' },
        },
      ],
    };
  });

  const run = await harness.createRun();
  const [step] = await harness.createSteps(run.runId, [
    {
      title: 'Pair the refund notes',
      workerType: 'note-pair',
      input: { transitionTo: 'Done' },
    },
  ]);
  await startRun(run.runId, harness.dependencies);
  const result = await harness.processNext();
  assert.equal(result.status, 'done');

  const childKey = (await harness.store.getStep(step.stepId)).childIssueKey;
  // The harness gives the first child the same key as the Epic, so a wave
  // report can share that key. It is enqueued later, by the lead, and is
  // not part of this step's comment list. The two worker comments are.
  const onStep = harness.enqueuedEffects.filter((effect) => (
    effect.stepId === step.stepId && effect.kind === 'comment'
  ));
  const batched = onStep.filter((effect) => effect.discriminator === 'batch:status-note+worker-output');
  assert.equal(batched.length, 1);
  assert.equal(onStep.some((effect) => effect.discriminator === 'worker-output'), false);
  assert.equal(onStep.some((effect) => effect.discriminator === 'status-note'), false);
  assert.equal(batched[0].payload.issueKey, childKey);
  assert.match(batched[0].payload.bodyText, /WORKER-OUTPUT the refund notes/);
  assert.match(batched[0].payload.bodyText, /STATUS-NOTE the step finished/);
  assert.deepEqual(batched[0].payload.batchedFrom, ['worker-output', 'status-note']);

  const transitions = harness.enqueuedEffects.filter((effect) => (
    effect.stepId === step.stepId && effect.kind === 'transition'
  ));
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].discriminator, 'transition:Done');
});

test('an unknown worker type fails the step and blocks the run', async () => {
  const harness = createHarness();
  const run = await harness.createRun();
  await harness.createSteps(run.runId, [
    { title: 'Mystery', workerType: 'not-installed', input: {} },
  ]);

  await startRun(run.runId, harness.dependencies);
  const [result] = await harness.processAll();
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'UNKNOWN_WORKER_TYPE');
  assert.equal((await harness.store.getRun(run.runId)).status, 'blocked');
});
