import assert from 'node:assert/strict';
import test from 'node:test';

import { createForgeStore } from '../index.js';
import { STUCK_QUEUED_MS } from '../types.js';
import { createFakeForgeSdk } from './fakeForgeKvs.js';

function createClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    },
    get current() {
      return current;
    },
  };
}

function createIds(prefix = 'id') {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function makeRunInput(overrides = {}) {
  return {
    epicKey: 'TC-1',
    projectKey: 'TC',
    goal: 'Ship payment refunds',
    createdBy: 'account-1',
    ...overrides,
  };
}

test('Forge adapter writes and reads a run through the entity API', async () => {
  const sdk = createFakeForgeSdk();
  const clock = createClock();
  const store = createForgeStore({
    sdk,
    now: clock.now,
    newId: createIds(),
  });

  const run = await store.createRun(makeRunInput());
  assert.equal(sdk.debug.get('run', run.runId).status, 'planning');
  assert.equal(sdk.calls.set.length, 1);
  assert.equal(sdk.calls.set[0].entityName, 'run');
  assert.equal(sdk.calls.set[0].options, undefined);

  const loaded = await store.getRun(run.runId);
  assert.deepEqual(loaded, run);
  assert.equal(await store.getRun('missing'), null);
});

test('Forge adapter strips undefined values before writing', async () => {
  const sdk = createFakeForgeSdk();
  const store = createForgeStore({
    sdk,
    now: createClock().now,
    newId: createIds(),
  });
  const run = await store.createRun(makeRunInput());
  const [step] = await store.createSteps(run.runId, [
    { title: 'Research', workerType: 'research' },
  ]);

  const stored = sdk.debug.get('step', step.stepId);
  assert.equal(Object.hasOwn(stored, 'input'), false);
  assert.equal(Object.hasOwn(stored, 'deadlineAt'), false);
  assert.equal(Object.hasOwn(stored, 'childIssueKey'), false);
});

test('putEffectIfAbsent uses FAIL_IF_EXISTS and returns the existing row', async () => {
  const sdk = createFakeForgeSdk();
  const clock = createClock();
  const store = createForgeStore({
    sdk,
    now: clock.now,
    newId: createIds(),
  });

  const first = await store.putEffectIfAbsent({
    requestKey: 'request-1',
    runId: 'run-1',
    stepId: 'step-1',
    kind: 'createIssue',
    payload: { projectKey: 'TC', summary: 'Child issue' },
  });
  assert.equal(first.created, true);
  assert.deepEqual(sdk.calls.set[0].options, { keyPolicy: 'FAIL_IF_EXISTS' });

  clock.advance(10);
  const second = await store.putEffectIfAbsent({
    requestKey: 'request-1',
    runId: 'run-1',
    stepId: 'step-1',
    kind: 'createIssue',
    payload: { projectKey: 'TC', summary: 'Ignored' },
  });
  assert.equal(second.created, false);
  assert.deepEqual(second.effect, first.effect);
  assert.equal(sdk.debug.size('effect'), 1);
  assert.equal(sdk.debug.get('effect', 'request-1').payload.summary, 'Child issue');
});

test('updateRun uses a transaction condition on updatedAt', async () => {
  const sdk = createFakeForgeSdk();
  const clock = createClock();
  const store = createForgeStore({
    sdk,
    now: clock.now,
    newId: createIds(),
  });
  const run = await store.createRun(makeRunInput());

  clock.advance(10);
  const updated = await store.updateRun(
    run.runId,
    { goal: 'Updated goal', status: 'running' },
    { expectedUpdatedAt: run.updatedAt },
  );

  assert.equal(sdk.calls.transactions.length, 1);
  const [operation] = sdk.calls.transactions[0].ops;
  assert.equal(operation.options.entityName, 'run');
  assert.deepEqual(operation.options.conditions.items, [
    {
      field: 'updatedAt',
      condition: 'EQUAL',
      value: run.updatedAt,
    },
  ]);
  assert.equal(sdk.debug.get('run', run.runId).goal, 'Updated goal');
  assert.equal(updated.updatedAt, clock.current);
});

test('updateRun rejects a stale optimistic write without writing', async () => {
  const sdk = createFakeForgeSdk();
  const clock = createClock();
  const store = createForgeStore({
    sdk,
    now: clock.now,
    newId: createIds(),
  });
  const run = await store.createRun(makeRunInput());
  const staleUpdatedAt = run.updatedAt;

  clock.advance(10);
  await store.updateRun(run.runId, { goal: 'First write' });
  const writesBefore = sdk.calls.set.length;

  clock.advance(10);
  await assert.rejects(
    store.updateRun(
      run.runId,
      { goal: 'Stale write' },
      { expectedUpdatedAt: staleUpdatedAt },
    ),
    { name: 'ConflictError', code: 'CONFLICT' },
  );
  assert.equal(sdk.calls.set.length, writesBefore);
  assert.equal(sdk.debug.get('run', run.runId).goal, 'First write');
});

test('Forge adapter follows nextCursor for listRunsByEpic pages', async () => {
  const sdk = createFakeForgeSdk({ maxPageSize: 40 });
  const clock = createClock();
  const store = createForgeStore({
    sdk,
    now: clock.now,
    newId: createIds('run'),
  });

  const runs = [];
  for (let index = 0; index < 205; index += 1) {
    runs.push(await store.createRun(makeRunInput({ epicKey: 'TC-1' })));
    clock.advance(1);
  }

  sdk.calls.queries.length = 0;
  const limited = await store.listRunsByEpic('TC-1', { limit: 150 });
  assert.equal(limited.length, 150);
  assert.equal(limited[0].runId, runs[204].runId);
  assert.equal(limited[149].runId, runs[55].runId);
  assert.ok(sdk.calls.queries.length >= 4);
  assert.deepEqual(
    limited.map((run) => run.createdAt),
    [...limited.map((run) => run.createdAt)].sort((a, b) => b - a),
  );
});

test('Forge adapter follows nextCursor for findStuckSteps pages', async () => {
  const sdk = createFakeForgeSdk({ maxPageSize: 40 });
  const clock = createClock();
  const store = createForgeStore({
    sdk,
    now: clock.now,
    newId: createIds('step'),
  });
  const run = await store.createRun(makeRunInput());
  const steps = await store.createSteps(
    run.runId,
    Array.from({ length: 120 }, (_, index) => ({
      title: `Step ${index}`,
      workerType: 'research',
    })),
  );

  const deadline = clock.current - 1;
  for (const step of steps.slice(0, 105)) {
    await store.updateStep(step.stepId, {
      status: 'running',
      attempt: 1,
      deadlineAt: deadline,
    });
  }

  clock.advance(STUCK_QUEUED_MS + 1);
  sdk.calls.queries.length = 0;
  const stuck = await store.findStuckSteps(clock.current);

  assert.equal(stuck.length, 120);
  assert.equal(
    stuck.filter((step) => step.status === 'running').length,
    105,
  );
  assert.equal(stuck.filter((step) => step.status === 'queued').length, 15);
  assert.ok(sdk.calls.queries.length >= 4);
});

test('Forge adapter can be constructed with an async SDK loader', async () => {
  const sdk = createFakeForgeSdk();
  const store = createForgeStore({
    loadSdk: async () => sdk,
    now: createClock().now,
    newId: createIds(),
  });
  const run = await store.createRun(makeRunInput());
  assert.equal((await store.getRun(run.runId)).runId, run.runId);
});

test('Forge adapter updateEffect writes only the changed fields and appliedAt', async () => {
  const sdk = createFakeForgeSdk();
  const clock = createClock();
  const store = createForgeStore({
    sdk,
    now: clock.now,
    newId: createIds(),
  });
  await store.putEffectIfAbsent({
    requestKey: 'request-1',
    runId: 'run-1',
    kind: 'comment',
    payload: { issueKey: 'TC-2', bodyText: 'hello' },
  });

  clock.advance(10);
  const applied = await store.updateEffect('request-1', {
    status: 'applied',
    tries: 1,
    result: { commentId: '10001' },
  });

  assert.equal(applied.status, 'applied');
  assert.equal(applied.appliedAt, clock.current);
  const stored = sdk.debug.get('effect', 'request-1');
  assert.equal(stored.status, 'applied');
  assert.equal(stored.result.commentId, '10001');
  assert.equal(stored.appliedAt, clock.current);
});

test('updates never write the row key as an attribute (Forge 422 regression)', async () => {
  const sdk = createFakeForgeSdk();
  const clock = createClock();
  const store = createForgeStore({ sdk, now: clock.now, newId: createIds() });
  const run = await store.createRun(makeRunInput());
  clock.advance(10);
  const updated = await store.updateRun(run.runId, { status: 'running' }, { expectedUpdatedAt: run.updatedAt });
  assert.equal(updated.runId, run.runId);
  const [operation] = sdk.calls.transactions.at(-1).ops;
  assert.equal('runId' in operation.value, false);
  assert.equal('runId' in sdk.debug.get('run', run.runId), false);
  assert.equal((await store.getRun(run.runId)).status, 'running');
  for (const call of sdk.calls.set) {
    const keyField = {
      run: 'runId',
      step: 'stepId',
      effect: 'requestKey',
      memory: 'memId',
      event: 'eventId',
    }[call.entityName];
    assert.equal(keyField in call.value, false, `${call.entityName} wrote ${keyField}`);
  }
});

test('flight-recorder append never stores the key and orders on integer seq', async () => {
  const sdk = createFakeForgeSdk();
  const clock = createClock();
  const store = createForgeStore({ sdk, now: clock.now, newId: createIds() });
  const run = await store.createRun(makeRunInput());
  clock.advance(5);
  const first = await store.appendEvent({
    runId: run.runId,
    kind: 'plan.created',
    detail: { goal: 'Ship payment refunds' },
    span: { 'gen_ai.operation.name': 'invoke_agent' },
  });
  clock.advance(5);
  const second = await store.appendEvent({
    runId: run.runId,
    kind: 'effect.written',
    journalKey: 'abc123',
    detail: { phase: 'applied' },
  });

  assert.equal(first.seq, 0);
  assert.equal(second.seq, 1);
  assert.equal(first.eventId.includes('#'), true);
  const stored = sdk.debug.get('event', first.eventId);
  assert.equal('eventId' in stored, false);
  assert.equal(stored.runId, run.runId);
  assert.equal(stored.seq, 0);
  assert.equal(typeof stored.at, 'number');
  // The by-run query conditions on integer seq, not the float `at`.
  const listed = await store.listEventsByRun(run.runId);
  assert.deepEqual(listed.map((event) => event.kind), ['plan.created', 'effect.written']);
  const byKey = await store.listEventsByJournalKey('abc123');
  assert.equal(byKey.length, 1);
  assert.equal(byKey[0].eventId, second.eventId);
  const rangeFields = sdk.calls.queries
    .filter((query) => query.entityName === 'event')
    .map((query) => query.indexName);
  assert.ok(rangeFields.every((name) => name === 'by-run' || name === 'by-journal'));
});
