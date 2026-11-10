/**
 * Flight recorder: journal, replay, fork, and the stall re-plan.
 *
 * Replay must re-read Jira and still report duplicateWrites 0. Fork must
 * copy the event prefix and enqueue only the downstream steps. The second
 * watchdog stall logs one `replan` event and does not add a Jira write.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { readFileSync } from 'node:fs';

import { RECORDER_DESCRIPTIONS, ACTION_DESCRIPTION_MAX } from '../../actions/contract.js';
import { requestKeyFor } from '../../effects/requestKey.js';
import { acceptLesson, addLesson } from '../../memory/lessons.js';
import { createMemoryStore } from '../../store/index.js';
import { createWatchdog } from '../../watchdog/index.js';
import { RETRY_DEADLINE_MS } from '../../watchdog/constants.js';
import { forkRun } from '../fork.js';
import { lookupAppliedEffect, stepResultKey } from '../journal.js';
import { buildGenAiSpan, DETERMINISTIC_MODEL } from '../otel.js';
import { replayRun } from '../replay.js';
import { STALL_REPLAN_THRESHOLD } from '../replan.js';
import { buildTimeline, scrubTo } from '../timeline.js';

function jiraStub(issues) {
  const reads = [];
  return {
    reads,
    async searchIssues() {
      reads.push('search');
      return issues;
    },
    async getIssueLinks() {
      reads.push('links');
      return [];
    },
  };
}

/**
 * Throw if replay or a dry-run tries to mutate the store or enqueue work.
 *
 * @param {import('../../store/types.js').Store} store
 * @param {{enqueueEffect: Function, enqueueStep: Function}} [queues]
 */
function guardWrites(store, queues = {}) {
  const writes = [];
  const wrap = (name, fn) => async (...args) => {
    writes.push(name);
    return fn(...args);
  };
  return {
    writes,
    store: {
      ...store,
      createRun: wrap('createRun', store.createRun.bind(store)),
      createSteps: wrap('createSteps', store.createSteps.bind(store)),
      updateRun: wrap('updateRun', store.updateRun.bind(store)),
      updateStep: wrap('updateStep', store.updateStep.bind(store)),
      putEffectIfAbsent: wrap('putEffectIfAbsent', store.putEffectIfAbsent.bind(store)),
      updateEffect: wrap('updateEffect', store.updateEffect.bind(store)),
      addMemory: wrap('addMemory', store.addMemory.bind(store)),
      appendEvent: wrap('appendEvent', store.appendEvent.bind(store)),
      getRun: store.getRun.bind(store),
      listSteps: store.listSteps.bind(store),
      listEffectsByRun: store.listEffectsByRun.bind(store),
      getEffect: store.getEffect.bind(store),
      listEventsByRun: store.listEventsByRun.bind(store),
      listEventsByJournalKey: store.listEventsByJournalKey.bind(store),
    },
    enqueueEffect: wrap('enqueueEffect', queues.enqueueEffect ?? (async () => {
      throw new Error('replay enqueued an effect');
    })),
    enqueueStep: wrap('enqueueStep', queues.enqueueStep ?? (async () => {
      throw new Error('replay enqueued a step');
    })),
  };
}

async function seedDoneRun(store) {
  const run = await store.createRun({
    epicKey: 'PAY-1',
    projectKey: 'PAY',
    goal: 'Ship payment refunds',
    createdBy: 'acct',
  });
  const steps = await store.createSteps(run.runId, [
    { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
    { title: 'Draft the spec', workerType: 'draft-spec', input: 'ledger', dependsOn: [0] },
    { title: 'Check capture', workerType: 'check-deps', input: 'capture', dependsOn: [1] },
  ]);
  for (const step of steps) {
    await store.updateStep(step.stepId, {
      status: 'done',
      output: { summary: step.title, workerType: step.workerType },
      childIssueKey: `PAY-${10 + step.idx}`,
    });
    await store.appendEvent({
      runId: run.runId,
      kind: 'step.succeeded',
      stepId: step.stepId,
      stepIdx: step.idx,
      at: 1_700_000_000_000 + step.idx * 1000,
      journalKey: stepResultKey({
        runId: run.runId,
        stepId: step.stepId,
        attempt: 0,
      }),
      detail: {
        title: step.title,
        workerType: step.workerType,
        output: { summary: step.title },
      },
    });
  }
  const requestKey = requestKeyFor({
    runId: run.runId,
    stepId: steps[0].stepId,
    kind: 'createIssue',
    discriminator: 'child-issue',
  });
  await store.putEffectIfAbsent({
    requestKey,
    runId: run.runId,
    stepId: steps[0].stepId,
    kind: 'createIssue',
    payload: {
      projectKey: 'PAY',
      parentKey: 'PAY-1',
      summary: steps[0].title,
      description: 'Goal',
      issueType: 'Sub-task',
    },
    status: 'applied',
    result: { issueKey: 'PAY-10' },
  });
  await store.appendEvent({
    runId: run.runId,
    kind: 'effect.written',
    stepId: steps[0].stepId,
    stepIdx: 0,
    journalKey: requestKey,
    detail: { phase: 'applied', kind: 'createIssue', requestKey },
  });
  await store.updateRun(run.runId, { status: 'done' });
  return { run: await store.getRun(run.runId), steps: await store.listSteps(run.runId), requestKey };
}

test('timeline scrubber reports durations and self-heal markers', async () => {
  const store = createMemoryStore({ now: () => 1_000 });
  const run = await store.createRun({
    epicKey: 'PAY-1',
    projectKey: 'PAY',
    goal: 'Ship refunds',
    createdBy: 'acct',
  });
  await store.appendEvent({
    runId: run.runId,
    kind: 'plan.created',
    at: 1_000,
    detail: { goal: 'Ship refunds' },
  });
  await store.appendEvent({
    runId: run.runId,
    kind: 'watchdog.self-heal',
    stepIdx: 1,
    at: 4_000,
    detail: { title: 'Research', workerType: 'research' },
  });
  const timeline = buildTimeline(await store.listEventsByRun(run.runId));
  assert.equal(timeline[1].durationMs, 3_000);
  assert.equal(timeline[1].selfHeal, true);
  assert.deepEqual(scrubTo(timeline, 0).map((event) => event.kind), ['plan.created']);
  const span = timeline[0];
  assert.equal(span.kind, 'plan.created');
});

test('an applied effect is a journal hit and replay writes nothing', async () => {
  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  const { run, requestKey } = await seedDoneRun(store);
  const looked = await lookupAppliedEffect(store, requestKey);
  assert.equal(looked.skipWrite, true);
  assert.equal(looked.verdict, 'already-applied-skipped');

  const guarded = guardWrites(store);
  const first = await replayRun(run.runId, {
    store: guarded.store,
    jira: jiraStub([]),
    now: () => 1_700_000_000_000,
  });
  assert.equal(first.dryRun, true);
  assert.equal(first.duplicateWrites, 0);
  assert.equal(first.sideEffects, false);
  assert.equal(guarded.writes.length, 0);
  assert.ok(first.effects.some((effect) => effect.verdict === 'already-applied-skipped'));
  assert.match(first.summary, /Duplicate writes: 0/);
  assert.match(first.summary, /today's Jira/);

  // Pin the journalled outputs to this Jira snapshot, then replay again.
  // A second pass with the same read must not report a false diff.
  for (const step of first.steps) {
    if (step.skipped || !step.stepId) {
      continue;
    }
    await store.updateStep(step.stepId, { output: step.after });
  }
  const same = await replayRun(run.runId, {
    store: guarded.store,
    jira: jiraStub([]),
    now: () => 1_700_000_000_000,
  });
  assert.deepEqual(same.changedSteps, []);
  assert.equal(guarded.writes.length, 0);

  const changed = await replayRun(run.runId, {
    store: guarded.store,
    jira: jiraStub([{ key: 'PAY-9', summary: 'New refund bug', status: 'Open', issueType: 'Bug' }]),
    now: () => 1_700_000_000_000,
  });
  assert.equal(changed.duplicateWrites, 0);
  assert.equal(guarded.writes.length, 0);
  assert.ok(changed.changedSteps.includes(0));
  const draft = changed.steps.find((step) => step.idx === 1);
  assert.equal(draft.changed, false);
});

test('fork copies the log up to step N and enqueues only downstream steps', async () => {
  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  const { run, steps } = await seedDoneRun(store);
  const before = await store.listSteps(run.runId);
  /** @type {object[]} */
  const effects = [];
  /** @type {object[]} */
  const queued = [];
  const forked = await forkRun({
    runId: run.runId,
    stepIdx: 1,
  }, {
    store,
    enqueueEffect: async (input) => {
      effects.push(input);
      return { requestKey: `new-${effects.length}`, created: true };
    },
    enqueueStep: async (payload) => {
      queued.push(payload);
      return { jobId: 'job' };
    },
    now: () => 1_700_000_000_000,
  });

  assert.equal(forked.forkedFromRunId, run.runId);
  assert.equal(forked.edited, false);
  assert.deepEqual(forked.copy, [0, 1]);
  assert.deepEqual(forked.rerun, [2]);
  assert.equal(effects.length, 1);
  assert.equal(effects[0].stepId !== steps[0].stepId, true);
  assert.equal(queued.length, 1);

  const copy = await store.listSteps(forked.runId);
  assert.equal(copy.find((step) => step.idx === 0).status, 'done');
  assert.equal(copy.find((step) => step.idx === 0).childIssueKey, 'PAY-10');
  assert.equal(copy.find((step) => step.idx === 1).status, 'done');
  assert.equal(copy.find((step) => step.idx === 2).status, 'queued');

  const copiedEvents = await store.listEventsByRun(forked.runId);
  assert.ok(copiedEvents.some((event) => event.kind === 'step.succeeded' && event.stepIdx === 1));
  assert.ok(copiedEvents.some((event) => event.kind === 'run.forked'));
  assert.equal(
    copiedEvents.filter((event) => event.kind === 'step.succeeded' && event.detail?.copiedFromRunId).length,
    2,
  );

  const originalSteps = await store.listSteps(run.runId);
  assert.deepEqual(
    originalSteps.map((step) => step.status),
    before.map((step) => step.status),
  );
  const originalEvents = await store.listEventsByRun(run.runId);
  assert.equal(originalEvents.filter((event) => event.kind === 'run.forked').length, 1);

  const linked = await store.getRun(forked.runId);
  assert.equal(linked.forkedFromRunId, run.runId);
  assert.equal(linked.forkedFromStepIdx, 1);
  const storedRun = await store.getRun(forked.runId);
  assert.equal(storedRun.forkedFromRunId, run.runId);
});

test('fork with a new input re-runs step N and its downstream steps', async () => {
  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  const { run } = await seedDoneRun(store);
  /** @type {object[]} */
  const effects = [];
  const forked = await forkRun({
    runId: run.runId,
    stepIdx: 1,
    input: 'narrow the ledger rule',
  }, {
    store,
    enqueueEffect: async (input) => {
      effects.push(input);
      return { requestKey: `edit-${effects.length}`, created: true };
    },
    enqueueStep: async () => ({ jobId: 'job' }),
    now: () => 1_700_000_000_000,
  });
  assert.equal(forked.edited, true);
  assert.deepEqual(forked.copy, [0]);
  assert.deepEqual(forked.rerun, [1, 2]);
  assert.equal(effects.length, 2);
  const copy = await store.listSteps(forked.runId);
  assert.equal(copy.find((step) => step.idx === 1).input, 'narrow the ledger rule');
  assert.equal(copy.find((step) => step.idx === 1).status, 'queued');
  const succeeded = (await store.listEventsByRun(forked.runId))
    .filter((event) => event.kind === 'step.succeeded');
  assert.deepEqual(succeeded.map((event) => event.stepIdx), [0]);
});

test('dependsOn limits the fork to the downstream DAG, not every later step', async () => {
  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  const run = await store.createRun({
    epicKey: 'PAY-1',
    projectKey: 'PAY',
    goal: 'Ship refunds',
    createdBy: 'acct',
  });
  const steps = await store.createSteps(run.runId, [
    { title: 'Root', workerType: 'research', input: 'root', dependsOn: [] },
    { title: 'Left', workerType: 'draft-spec', input: 'left', dependsOn: [0] },
    { title: 'Right', workerType: 'draft-spec', input: 'right', dependsOn: [0] },
    { title: 'After left', workerType: 'check-deps', input: 'after', dependsOn: [1] },
  ]);
  for (const step of steps) {
    await store.updateStep(step.stepId, { status: 'done', output: { summary: step.title } });
  }
  const forked = await forkRun({ runId: run.runId, stepIdx: 1 }, {
    store,
    enqueueEffect: async () => ({ requestKey: 'dag', created: true }),
    enqueueStep: async () => ({ jobId: 'job' }),
    now: () => 1_700_000_000_000,
  });
  assert.equal(forked.mode, 'dag');
  assert.deepEqual(forked.rerun, [3]);
  assert.deepEqual(forked.copy, [0, 1, 2]);
});

test('the second stall requests one partial re-plan and does not write to Jira', async () => {
  assert.equal(STALL_REPLAN_THRESHOLD, 2);
  const clock = { value: 1_700_000_000_000 };
  const store = createMemoryStore({ now: () => clock.value });
  const run = await store.createRun({
    epicKey: 'PAY-1',
    projectKey: 'PAY',
    goal: 'Ship refunds',
    createdBy: 'acct',
  });
  const [step, later] = await store.createSteps(run.runId, [
    { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
    { title: 'Draft the spec', workerType: 'draft-spec', input: 'ledger', dependsOn: [0] },
  ]);
  // The later step is already done, so a clock jump cannot treat it as a
  // second stuck queued step. The re-plan should still name it as downstream.
  await store.updateStep(later.stepId, { status: 'done', output: { summary: 'draft' } });
  await store.updateRun(run.runId, { status: 'running' });
  await store.updateStep(step.stepId, {
    status: 'running',
    attempt: 0,
    deadlineAt: clock.value - 1,
  });
  /** @type {object[]} */
  const effects = [];
  const watchdog = createWatchdog({
    store,
    pushStep: async () => ({ ok: true }),
    pushEffect: async () => ({ ok: true }),
    enqueueEffect: async (input) => {
      effects.push(input);
      return { requestKey: 'should-not-happen', created: true };
    },
    now: () => clock.value,
    logger: { info() {}, warn() {}, error() {} },
  });

  const first = await watchdog.run();
  assert.equal(first.retriedSteps.length, 1);
  assert.equal(effects.length, 0);
  let events = await store.listEventsByRun(run.runId);
  assert.equal(events.filter((event) => event.kind === 'replan').length, 0);
  assert.equal((await store.getStep(step.stepId)).stallCount, 1);
  assert.equal((await store.getStep(step.stepId)).input, 'refunds');

  clock.value += RETRY_DEADLINE_MS + 1;
  const second = await watchdog.run();
  assert.equal(second.retriedSteps.length, 1);
  assert.equal(second.retriedSteps[0].attempt, 2);
  assert.equal(effects.length, 0);
  events = await store.listEventsByRun(run.runId);
  const replans = events.filter((event) => event.kind === 'replan');
  assert.equal(replans.length, 1);
  assert.equal(replans[0].detail.stallCount, 2);
  assert.equal(replans[0].detail.revisedSteps[0].idx, 0);
  assert.ok(replans[0].detail.revisedSteps.some((item) => item.idx === 1));
  assert.equal(replans[0].span['gen_ai.request.model'], DETERMINISTIC_MODEL);
  assert.equal(replans[0].span['gen_ai.operation.name'], 'invoke_agent');
  assert.equal((await store.getStep(step.stepId)).input, 'refunds');
  const frame = buildTimeline(events).find((event) => event.kind === 'replan');
  assert.equal(frame.replan, true);
  assert.ok(events.some((event) => event.kind === 'watchdog.self-heal'));
  assert.ok(events.some((event) => event.kind === 'step.retried'));
});

test('a succeeded step records the model that actually ran', () => {
  const fallback = buildGenAiSpan({
    runId: 'run-1',
    kind: 'step.succeeded',
    detail: { workerType: 'research', generator: 'fallback', model: null },
  });
  assert.equal(fallback['gen_ai.request.model'], DETERMINISTIC_MODEL);
  const hosted = buildGenAiSpan({
    runId: 'run-1',
    kind: 'step.succeeded',
    detail: { workerType: 'research', generator: 'llm', model: 'claude-haiku-4-5-20251001' },
  });
  assert.equal(hosted['gen_ai.request.model'], 'claude-haiku-4-5-20251001');
  assert.equal(hosted['gen_ai.operation.name'], 'execute_tool');
});

test('replay uses lessons valid at the run and diffs newer ones', async () => {
  let now = 1_700_000_000_000;
  const store = createMemoryStore({ now: () => now });
  const { run } = await seedDoneRun(store);
  now += 60_000;
  const added = await addLesson({
    projectKey: 'PAY',
    scope: 'project',
    epicKey: 'PAY-1',
    text: 'Refund plans must check capture first.',
    cause: 'missing capture check',
    goal: 'Ship payment refunds',
  }, { store, now: () => now });
  const accepted = await acceptLesson({
    lessonId: added.lessonId,
    projectKey: 'PAY',
  }, { store, now: () => now });
  now += 60_000;
  const guarded = guardWrites(store);
  const replay = await replayRun(run.runId, {
    store: guarded.store,
    jira: jiraStub([]),
    now: () => now,
  });
  assert.equal(replay.duplicateWrites, 0);
  assert.equal(guarded.writes.length, 0);
  assert.equal(replay.lessons.asOf, run.createdAt);
  assert.ok(!replay.lessons.validThen.some((lesson) => lesson.lessonId === accepted.lessonId));
  assert.ok(replay.lessons.newer.some((lesson) => lesson.lessonId === accepted.lessonId));
  assert.equal(replay.lessons.planWouldChange, true);
  assert.ok(replay.lessons.changes.some((change) => change.lessonId === accepted.lessonId));
  assert.match(replay.summary, /newer lesson/);
});

test('replay and fork descriptions follow the 255 character action contract', () => {
  const manifest = readFileSync(new URL('../../../manifest.yml', import.meta.url), 'utf8');
  const snippet = readFileSync(new URL('../../actions/actions.manifest.yml', import.meta.url), 'utf8');
  for (const [key, description] of Object.entries(RECORDER_DESCRIPTIONS)) {
    assert.ok(description.length <= ACTION_DESCRIPTION_MAX, `${key} is ${description.length}`);
    assert.ok(description.length >= 50, key);
    assert.ok(manifest.includes(description), key);
    assert.ok(snippet.includes(description), key);
  }
  assert.equal(manifest.includes('key: conductor-mcp'), true);
  const mcp = manifest.slice(manifest.indexOf('key: conductor-mcp'), manifest.indexOf('action:'));
  assert.equal(mcp.includes('replay-run'), false);
  assert.equal(mcp.includes('fork-run'), false);
});
