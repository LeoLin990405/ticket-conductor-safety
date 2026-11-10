/**
 * WP4 watchdog tests.
 *
 * These use WP1's memory adapter. WP2 `enqueueEffect` and the WP2/WP3 queue
 * producers are recorder functions, which is the documented injection point
 * for packages that are built in parallel.
 *
 * @module watchdog/tests/watchdog
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryStore, STUCK_QUEUED_MS } from '../../store/index.js';
import {
  MAX_STEP_ATTEMPTS,
  RETRY_DEADLINE_MS,
  STALE_EFFECT_MS,
} from '../constants.js';
import {
  demoHangDelayMs,
  demoStuckStepIdx,
  getDemoStuckValue,
  isDemoStuckEnabled,
  shouldDemoHang,
} from '../demo.js';
import {
  createWatchdog,
  createWatchdogHandler,
  requestKeyFor,
  watchdogHandler,
} from '../index.js';
import {
  createClock,
  createRecordingQueue,
  createRunWithSteps,
  createWatchdogDeps,
  markRunningOverdue,
} from './helpers.js';

test('watchdogHandler is exported for the Forge scheduledTrigger', () => {
  assert.equal(typeof watchdogHandler, 'function');
});

test('retries a stuck running step with attempt + 1 and a new deadline', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now });
  const { run, steps } = await createRunWithSteps(store);
  const now = clock.now();
  await markRunningOverdue(store, steps[0], { now, attempt: 0 });

  const { deps, stepQueue, effectQueue } = createWatchdogDeps(store, {
    now: clock.now,
  });
  const summary = await createWatchdog(deps).run();

  assert.deepEqual(stepQueue.calls, [
    { runId: run.runId, stepId: steps[0].stepId, attempt: 1 },
  ]);
  assert.equal(effectQueue.calls.length, 0);

  const updated = await store.getStep(steps[0].stepId);
  assert.equal(updated.status, 'queued');
  assert.equal(updated.attempt, 1);
  assert.equal(updated.deadlineAt, now + RETRY_DEADLINE_MS);
  assert.deepEqual(summary.retriedSteps, [
    { runId: run.runId, stepId: steps[0].stepId, attempt: 1 },
  ]);
  assert.deepEqual(summary.failedSteps, []);
  assert.deepEqual(summary.errors, []);
});

test('retries a queued step that has waited longer than ten minutes', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now });
  const { run, steps } = await createRunWithSteps(store);

  clock.advance(STUCK_QUEUED_MS + 1);
  const { deps, stepQueue } = createWatchdogDeps(store, { now: clock.now });
  const summary = await createWatchdog(deps).run();

  assert.deepEqual(stepQueue.calls, [
    { runId: run.runId, stepId: steps[0].stepId, attempt: 1 },
  ]);
  const updated = await store.getStep(steps[0].stepId);
  assert.equal(updated.status, 'queued');
  assert.equal(updated.attempt, 1);
  assert.equal(summary.retriedSteps.length, 1);
});

test('does not retry a re-queued step again before its new deadline', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now });
  const { steps } = await createRunWithSteps(store);

  clock.advance(STUCK_QUEUED_MS + 1);
  const now = clock.now();
  await markRunningOverdue(store, steps[0], { now });

  const { deps, stepQueue } = createWatchdogDeps(store, { now: clock.now });
  const watchdog = createWatchdog(deps);
  const first = await watchdog.run();
  assert.equal(first.retriedSteps.length, 1);
  assert.equal(stepQueue.calls.length, 1);

  const requeued = await store.getStep(steps[0].stepId);
  assert.equal(requeued.status, 'queued');
  assert.equal(requeued.attempt, 1);
  assert.ok(requeued.deadlineAt > now);

  const second = await watchdog.run();
  assert.equal(second.scannedSteps, 1);
  assert.equal(second.retriedSteps.length, 0);
  assert.equal(second.skippedSteps[0].reason, 'no-longer-stuck');
  assert.equal(stepQueue.calls.length, 1);
  assert.equal((await store.getStep(steps[0].stepId)).attempt, 1);
});

test('does not retry a queued step exactly at the ten minute boundary', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now });
  await createRunWithSteps(store);

  clock.advance(STUCK_QUEUED_MS);
  const { deps, stepQueue } = createWatchdogDeps(store, { now: clock.now });
  const summary = await createWatchdog(deps).run();

  assert.equal(stepQueue.calls.length, 0);
  assert.equal(summary.scannedSteps, 0);
  assert.equal(summary.retriedSteps.length, 0);
});

test('skips a step that finished after the findStuckSteps snapshot', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now });
  const { steps } = await createRunWithSteps(store);
  const now = clock.now();
  const snapshot = await markRunningOverdue(store, steps[0], { now });

  const staleStore = Object.create(store);
  staleStore.findStuckSteps = async () => [snapshot];
  staleStore.getStep = async () => ({ ...snapshot, status: 'done' });

  const { deps, stepQueue } = createWatchdogDeps(staleStore, {
    now: clock.now,
  });
  const summary = await createWatchdog(deps).run();

  assert.equal(stepQueue.calls.length, 0);
  assert.deepEqual(summary.skippedSteps, [
    {
      stepId: steps[0].stepId,
      runId: snapshot.runId,
      reason: 'no-longer-stuck',
    },
  ]);
});

test('attempt 3 fails the step, blocks the run, and enqueues one deduped comment', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now });
  const { run, steps } = await createRunWithSteps(store);
  const now = clock.now();
  await markRunningOverdue(store, steps[0], {
    now,
    attempt: MAX_STEP_ATTEMPTS,
  });

  const { deps, stepQueue, effectQueue } = createWatchdogDeps(store, {
    now: clock.now,
  });
  const watchdog = createWatchdog(deps);
  const first = await watchdog.run();

  assert.equal(stepQueue.calls.length, 0);
  assert.equal(effectQueue.calls.length, 1);
  assert.equal(first.failedSteps.length, 1);

  const updatedStep = await store.getStep(steps[0].stepId);
  assert.equal(updatedStep.status, 'failed');
  assert.equal(updatedStep.attempt, MAX_STEP_ATTEMPTS);
  assert.equal(updatedStep.deadlineAt, undefined);
  assert.equal(updatedStep.error.code, 'WATCHDOG_ATTEMPTS_EXHAUSTED');
  assert.equal(updatedStep.error.attempts, MAX_STEP_ATTEMPTS);

  const updatedRun = await store.getRun(run.runId);
  assert.equal(updatedRun.status, 'blocked');

  const pending = await store.listEffectsByStatus('pending');
  assert.equal(pending.length, 1);
  const [effect] = pending;
  assert.equal(effect.kind, 'comment');
  assert.equal(effect.runId, run.runId);
  assert.equal(effect.stepId, steps[0].stepId);
  assert.equal(effect.payload.issueKey, run.epicKey);
  assert.match(effect.payload.bodyText, /\[Conductor watchdog\]/);
  assert.match(effect.payload.bodyText, /Step 1: Step 1/);
  assert.equal(
    effect.requestKey,
    requestKeyFor({
      runId: run.runId,
      stepId: steps[0].stepId,
      kind: 'comment',
      discriminator: 'watchdog-blocked',
    }),
  );
  assert.deepEqual(effectQueue.calls, [{ requestKey: effect.requestKey }]);

  // Simulate a later watchdog pass finding the same stale failure again. The
  // comment effect already exists, so no second effect or queue push appears.
  await markRunningOverdue(store, steps[0], {
    now,
    attempt: MAX_STEP_ATTEMPTS,
  });
  const second = await watchdog.run();

  assert.equal(second.failedSteps.length, 1);
  assert.equal((await store.listEffectsByStatus('pending')).length, 1);
  assert.equal(effectQueue.calls.length, 1);
  assert.equal(stepQueue.calls.length, 0);
});

test('uses an injected WP2 enqueueEffect instead of writing the effect itself', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now });
  const { run, steps } = await createRunWithSteps(store);
  const now = clock.now();
  await markRunningOverdue(store, steps[0], {
    now,
    attempt: MAX_STEP_ATTEMPTS,
  });

  const calls = [];
  const enqueueEffect = async (input) => {
    calls.push(input);
    return { requestKey: 'injected-request-key', created: true };
  };
  const { deps, effectQueue } = createWatchdogDeps(store, {
    now: clock.now,
    enqueueEffect,
  });
  const summary = await createWatchdog(deps).run();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].runId, run.runId);
  assert.equal(calls[0].stepId, steps[0].stepId);
  assert.equal(calls[0].kind, 'comment');
  assert.equal(calls[0].discriminator, 'watchdog-blocked');
  assert.equal(calls[0].payload.issueKey, run.epicKey);
  assert.equal(effectQueue.calls.length, 0);
  assert.equal((await store.listEffectsByStatus('pending')).length, 0);
  assert.equal(
    summary.failedSteps[0].requestKey,
    'injected-request-key',
  );
});

test('re-pushes pending and retrying effects older than five minutes only', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now });
  const start = clock.now();

  await store.putEffectIfAbsent({
    requestKey: 'old-pending',
    kind: 'comment',
    payload: { issueKey: 'PAY-100' },
  });
  await store.putEffectIfAbsent({
    requestKey: 'old-retrying',
    kind: 'comment',
    payload: { issueKey: 'PAY-100' },
    status: 'retrying',
    tries: 2,
  });

  clock.set(start + STALE_EFFECT_MS);
  await store.putEffectIfAbsent({
    requestKey: 'boundary-pending',
    kind: 'comment',
    payload: { issueKey: 'PAY-100' },
  });

  clock.set(start + STALE_EFFECT_MS * 2);
  await store.putEffectIfAbsent({
    requestKey: 'fresh-pending',
    kind: 'comment',
    payload: { issueKey: 'PAY-100' },
  });

  const { deps, effectQueue, stepQueue } = createWatchdogDeps(store, {
    now: clock.now,
  });
  const summary = await createWatchdog(deps).run();

  const pushed = effectQueue.calls
    .map((call) => call.requestKey)
    .sort();
  assert.deepEqual(pushed, ['old-pending', 'old-retrying']);
  assert.deepEqual(
    summary.repushedEffects.map((entry) => entry.requestKey).sort(),
    ['old-pending', 'old-retrying'],
  );
  assert.equal(stepQueue.calls.length, 0);
  assert.deepEqual(summary.errors, []);
});

test('continues other steps when one queue push fails and rewinds that attempt', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now });
  const { steps } = await createRunWithSteps(store, { stepCount: 2 });
  const now = clock.now();
  await markRunningOverdue(store, steps[0], { now });
  await markRunningOverdue(store, steps[1], { now });

  const stepQueue = createRecordingQueue({
    failOn: (payload) => payload.stepId === steps[0].stepId,
  });
  const { deps } = createWatchdogDeps(store, {
    now: clock.now,
    stepQueue,
  });
  const summary = await createWatchdog(deps).run();

  assert.equal(stepQueue.calls.length, 2);
  assert.equal(summary.retriedSteps.length, 1);
  assert.equal(summary.retriedSteps[0].stepId, steps[1].stepId);
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0].scope, 'step');

  const failedPushStep = await store.getStep(steps[0].stepId);
  assert.equal(failedPushStep.attempt, 0);
  assert.equal(failedPushStep.status, 'queued');
  assert.ok(failedPushStep.deadlineAt < now);
});

test('createWatchdogHandler returns a reusable scheduled handler', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now });
  const { steps } = await createRunWithSteps(store);
  const now = clock.now();
  await markRunningOverdue(store, steps[0], { now });

  const { deps, stepQueue } = createWatchdogDeps(store, { now: clock.now });
  const handler = createWatchdogHandler(deps);
  const first = await handler();
  const second = await handler();

  assert.equal(first.retriedSteps.length, 1);
  assert.equal(second.retriedSteps.length, 0);
  assert.equal(stepQueue.calls.length, 1);
});

test('demo flag helpers select exactly one step and only on attempt 0', () => {
  assert.equal(getDemoStuckValue({}), '');
  assert.equal(isDemoStuckEnabled({}), false);
  assert.equal(isDemoStuckEnabled({ CONDUCTOR_DEMO_STUCK_STEP: '   ' }), false);
  assert.equal(demoStuckStepIdx({}), null);

  const enabled = { CONDUCTOR_DEMO_STUCK_STEP: '1' };
  assert.equal(isDemoStuckEnabled(enabled), true);
  assert.equal(demoStuckStepIdx(enabled), 0);
  assert.equal(
    demoStuckStepIdx({ CONDUCTOR_DEMO_STUCK_STEP: '2' }),
    2,
  );
  assert.equal(
    demoStuckStepIdx({ CONDUCTOR_DEMO_STUCK_STEP: 'anything' }),
    0,
  );

  const firstStep = {
    idx: 0,
    status: 'running',
    attempt: 0,
    deadlineAt: 5_000,
  };
  assert.equal(shouldDemoHang(firstStep, enabled), true);
  assert.equal(
    shouldDemoHang({ ...firstStep, attempt: 1 }, enabled),
    false,
  );
  assert.equal(
    shouldDemoHang({ ...firstStep, status: 'done' }, enabled),
    false,
  );
  assert.equal(
    shouldDemoHang({ ...firstStep, idx: 1 }, enabled),
    false,
  );
  assert.equal(shouldDemoHang(firstStep, {}), false);

  assert.equal(demoHangDelayMs(firstStep, { env: enabled, now: 4_000 }), 2_000);
  assert.equal(demoHangDelayMs(firstStep, { env: {}, now: 4_000 }), 0);
});

test('watchdog reports the demo flag without changing normal retry rules', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now });
  const { deps } = createWatchdogDeps(store, {
    now: clock.now,
    env: { CONDUCTOR_DEMO_STUCK_STEP: '1' },
  });
  const summary = await createWatchdog(deps).run();
  assert.equal(summary.demoStuck, true);
});

test('handles 200 stuck steps in under 25 seconds', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now });
  const { steps } = await createRunWithSteps(store, { stepCount: 200 });
  const now = clock.now();
  await Promise.all(
    steps.map((step) => markRunningOverdue(store, step, { now })),
  );

  const { deps, stepQueue } = createWatchdogDeps(store, {
    now: clock.now,
    concurrency: 20,
  });
  const started = Date.now();
  const summary = await createWatchdog(deps).run();
  const elapsedMs = Date.now() - started;

  assert.equal(summary.scannedSteps, 200);
  assert.equal(summary.retriedSteps.length, 200);
  assert.equal(summary.failedSteps.length, 0);
  assert.deepEqual(summary.errors, []);
  assert.equal(stepQueue.calls.length, 200);
  assert.equal(new Set(stepQueue.calls.map((call) => call.stepId)).size, 200);
  assert.ok(
    stepQueue.calls.every((call) => call.attempt === 1),
    'every retry should advance to attempt 1',
  );
  assert.ok(
    elapsedMs < 25_000,
    `watchdog took ${elapsedMs}ms for 200 steps, expected <25000ms`,
  );
});

test('does not retry an approval gate that was left queued or running', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now });
  const run = await store.createRun({
    epicKey: 'PAY-1',
    projectKey: 'PAY',
    goal: 'Ship payment refunds',
    createdBy: 'account-1',
  });
  const [gate, waiting] = await store.createSteps(run.runId, [
    { title: 'Approve blast radius', workerType: 'approval', input: {}, dependsOn: [] },
    { title: 'Draft the spec', workerType: 'draft-spec', input: {}, dependsOn: [0] },
  ]);
  await store.updateStep(waiting.stepId, { status: 'waiting' });
  await markRunningOverdue(store, gate, { now: clock.now(), attempt: 0 });

  const { deps, stepQueue } = createWatchdogDeps(store, { now: clock.now });
  const runningPass = await createWatchdog(deps).run();
  assert.equal(runningPass.retriedSteps.length, 0);
  assert.equal(runningPass.failedSteps.length, 0);
  assert.equal(runningPass.skippedSteps[0].reason, 'approval-gate');
  assert.equal(stepQueue.calls.length, 0);
  const parked = await store.getStep(gate.stepId);
  assert.equal(parked.status, 'waiting');
  assert.equal(parked.attempt, 0);

  // A later pass must not see the parked gate. The dependent stays waiting
  // and is not in the stuck query either.
  clock.advance(STUCK_QUEUED_MS + 1);
  const again = await createWatchdog(deps).run();
  assert.equal(again.scannedSteps, 0);
  assert.equal(again.retriedSteps.length, 0);
  assert.equal((await store.getStep(waiting.stepId)).status, 'waiting');
  assert.equal((await store.getStep(waiting.stepId)).attempt, 0);
  assert.equal(stepQueue.calls.length, 0);
});
