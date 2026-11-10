import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConflictError,
  NotFoundError,
  StoreValidationError,
  ValueTooLargeError,
  createMemoryStore,
} from '../index.js';
import { MAX_VALUE_BYTES, STUCK_QUEUED_MS } from '../types.js';

/**
 * Deterministic clock so timestamp assertions are exact.
 *
 * @param {number} [start]
 */
function createClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    },
    set(ms) {
      current = ms;
      return current;
    },
    get current() {
      return current;
    },
  };
}

/**
 * Deterministic uuid-shaped ids.
 *
 * @param {string} [prefix]
 */
function createIds(prefix = 'id') {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function bytesOfText(bytes) {
  return 'x'.repeat(bytes);
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

test('createRun stores a planning run and getRun returns it', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now, newId: createIds() });

  const run = await store.createRun(makeRunInput());

  assert.equal(run.runId, 'id-1');
  assert.equal(run.status, 'planning');
  assert.equal(run.epicKey, 'TC-1');
  assert.equal(run.projectKey, 'TC');
  assert.equal(run.goal, 'Ship payment refunds');
  assert.equal(run.createdBy, 'account-1');
  assert.equal(run.createdAt, clock.current);
  assert.equal(run.updatedAt, clock.current);
  assert.deepEqual(await store.getRun(run.runId), run);
  assert.equal(await store.getRun('missing-run'), null);
});

test('createRun generates uuid v4 ids when no id generator is injected', async () => {
  const store = createMemoryStore();
  const run = await store.createRun(makeRunInput());
  assert.match(
    run.runId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
});

test('createRun validates required string fields', async () => {
  const store = createMemoryStore();
  await assert.rejects(store.createRun(makeRunInput({ epicKey: '' })), {
    name: 'StoreValidationError',
    code: 'VALIDATION',
  });
  await assert.rejects(store.createRun(makeRunInput({ goal: undefined })), {
    name: 'StoreValidationError',
  });
});

test('listRunsByEpic filters by Epic, sorts newest first, and honours limit', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now, newId: createIds() });

  const first = await store.createRun(makeRunInput({ epicKey: 'TC-1' }));
  clock.advance(10);
  const second = await store.createRun(makeRunInput({ epicKey: 'TC-1' }));
  clock.advance(10);
  const otherEpic = await store.createRun(makeRunInput({ epicKey: 'TC-2' }));

  const all = await store.listRunsByEpic('TC-1');
  assert.deepEqual(
    all.map((run) => run.runId),
    [second.runId, first.runId],
  );
  assert.equal(all.some((run) => run.runId === otherEpic.runId), false);

  const limited = await store.listRunsByEpic('TC-1', { limit: 1 });
  assert.deepEqual(
    limited.map((run) => run.runId),
    [second.runId],
  );
  assert.deepEqual(await store.listRunsByEpic('TC-1', { limit: 0 }), []);
  await assert.rejects(store.listRunsByEpic('TC-1', { limit: -1 }), {
    name: 'StoreValidationError',
  });
});

test('updateRun applies patches and bumps updatedAt', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now, newId: createIds() });
  const run = await store.createRun(makeRunInput());

  clock.advance(25);
  const updated = await store.updateRun(
    run.runId,
    { goal: 'Updated goal', status: 'running' },
    { expectedUpdatedAt: run.updatedAt },
  );

  assert.equal(updated.goal, 'Updated goal');
  assert.equal(updated.status, 'running');
  assert.equal(updated.updatedAt, clock.current);
  assert.equal(updated.createdAt, run.createdAt);
  assert.deepEqual(await store.getRun(run.runId), updated);
});

test('updateRun throws ConflictError for a stale expectedUpdatedAt', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now, newId: createIds() });
  const run = await store.createRun(makeRunInput());
  const staleUpdatedAt = run.updatedAt;

  clock.advance(1);
  const current = await store.updateRun(run.runId, { goal: 'First write' });

  clock.advance(1);
  await assert.rejects(
    store.updateRun(
      run.runId,
      { goal: 'Stale write' },
      { expectedUpdatedAt: staleUpdatedAt },
    ),
    (error) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.name, 'ConflictError');
      assert.equal(error.code, 'CONFLICT');
      assert.equal(error.expectedUpdatedAt, staleUpdatedAt);
      assert.equal(error.actualUpdatedAt, current.updatedAt);
      return true;
    },
  );

  const stored = await store.getRun(run.runId);
  assert.equal(stored.goal, 'First write');
});

test('concurrent optimistic updates have one winner and one ConflictError', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now, newId: createIds() });
  const run = await store.createRun(makeRunInput());

  const results = await Promise.allSettled([
    store.updateRun(
      run.runId,
      { goal: 'Writer A' },
      { expectedUpdatedAt: run.updatedAt },
    ),
    store.updateRun(
      run.runId,
      { goal: 'Writer B' },
      { expectedUpdatedAt: run.updatedAt },
    ),
  ]);

  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.name, 'ConflictError');

  const stored = await store.getRun(run.runId);
  assert.equal(stored.goal, fulfilled[0].value.goal);
});

test('updateRun keeps timestamps monotonic within the same millisecond', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now, newId: createIds() });
  const run = await store.createRun(makeRunInput());

  const first = await store.updateRun(run.runId, { summary: { text: 'one' } });
  const second = await store.updateRun(first.runId, {
    summary: { text: 'two' },
  });

  assert.ok(second.updatedAt > first.updatedAt);
  assert.ok(first.updatedAt > run.updatedAt);
});

test('updateRun rejects unknown runs and immutable identity fields', async () => {
  const store = createMemoryStore();
  await assert.rejects(store.updateRun('missing', { goal: 'x' }), {
    name: 'NotFoundError',
  });

  const run = await store.createRun(makeRunInput());
  await assert.rejects(store.updateRun(run.runId, { runId: 'other' }), {
    name: 'StoreValidationError',
  });
  await assert.rejects(store.updateRun(run.runId, { createdAt: 1 }), {
    name: 'StoreValidationError',
  });
  await assert.rejects(store.updateRun(run.runId, { status: 'bogus' }), {
    name: 'StoreValidationError',
  });
});

test('createSteps assigns idx from zero and queues each step', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now, newId: createIds() });
  const run = await store.createRun(makeRunInput());

  const steps = await store.createSteps(run.runId, [
    { title: 'Research', workerType: 'research', input: { jql: 'project=TC' } },
    { title: 'Draft', workerType: 'draft-spec', input: { sections: 3 } },
    { title: 'Check deps', workerType: 'check-deps' },
  ]);

  assert.equal(steps.length, 3);
  assert.deepEqual(
    steps.map((step) => step.idx),
    [0, 1, 2],
  );
  assert.deepEqual(
    steps.map((step) => step.stepId),
    ['id-2', 'id-3', 'id-4'],
  );
  for (const step of steps) {
    assert.equal(step.runId, run.runId);
    assert.equal(step.status, 'queued');
    assert.equal(step.attempt, 0);
    assert.equal(step.createdAt, clock.current);
    assert.equal(step.deadlineAt, undefined);
  }
  assert.deepEqual(steps[0].input, { jql: 'project=TC' });
  assert.equal(steps[2].input, undefined);

  const listed = await store.listSteps(run.runId);
  assert.deepEqual(
    listed.map((step) => step.stepId),
    ['id-2', 'id-3', 'id-4'],
  );
  assert.deepEqual(await store.getStep('id-3'), steps[1]);
  assert.equal(await store.getStep('missing-step'), null);
  assert.deepEqual(await store.createSteps(run.runId, []), []);

  // A later batch keeps going. The summarize step is created this way.
  const [extra] = await store.createSteps(run.runId, [
    { title: 'Summarize', workerType: 'summarize', input: { auto: true } },
  ]);
  assert.equal(extra.idx, 3);
  assert.deepEqual(
    (await store.listSteps(run.runId)).map((step) => step.idx),
    [0, 1, 2, 3],
  );
});

test('createSteps validates the whole plan before writing anything', async () => {
  const store = createMemoryStore();
  const run = await store.createRun(makeRunInput());

  await assert.rejects(
    store.createSteps(run.runId, [
      { title: 'Valid', workerType: 'research' },
      { title: '', workerType: 'research' },
    ]),
    { name: 'StoreValidationError' },
  );
  assert.deepEqual(await store.listSteps(run.runId), []);
});

test('updateStep merges worker state and protects identity fields', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now, newId: createIds() });
  const run = await store.createRun(makeRunInput());
  const [step] = await store.createSteps(run.runId, [
    { title: 'Research', workerType: 'research' },
  ]);

  clock.advance(500);
  const running = await store.updateStep(step.stepId, {
    status: 'running',
    attempt: 1,
    deadlineAt: clock.current + 12 * 60 * 1000,
    childIssueKey: 'TC-2',
  });
  assert.equal(running.status, 'running');
  assert.equal(running.attempt, 1);
  assert.equal(running.deadlineAt, clock.current + 12 * 60 * 1000);
  assert.equal(running.childIssueKey, 'TC-2');
  assert.equal(running.createdAt, step.createdAt);

  clock.advance(100);
  const done = await store.updateStep(step.stepId, {
    status: 'done',
    output: { summary: 'ok' },
  });
  assert.equal(done.status, 'done');
  assert.deepEqual(done.output, { summary: 'ok' });

  await assert.rejects(store.updateStep('missing', { status: 'done' }), {
    name: 'NotFoundError',
  });
  await assert.rejects(store.updateStep(step.stepId, { idx: 9 }), {
    name: 'StoreValidationError',
  });
  await assert.rejects(store.updateStep(step.stepId, { runId: 'other' }), {
    name: 'StoreValidationError',
  });
  await assert.rejects(store.updateStep(step.stepId, { attempt: -1 }), {
    name: 'StoreValidationError',
  });
});

test('findStuckSteps returns overdue running steps and old queued steps', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now, newId: createIds() });
  const run = await store.createRun(makeRunInput());
  const [queuedOld, runningOverdue, runningFuture] = await store.createSteps(
    run.runId,
    [
      { title: 'Old queued', workerType: 'research' },
      { title: 'Overdue running', workerType: 'research' },
      { title: 'Future running', workerType: 'research' },
    ],
  );

  await store.updateStep(runningOverdue.stepId, {
    status: 'running',
    deadlineAt: clock.current + 1_000,
  });
  await store.updateStep(runningFuture.stepId, {
    status: 'running',
    deadlineAt: clock.current + 24 * 60 * 60 * 1000,
  });

  clock.advance(2_000);
  let stuck = await store.findStuckSteps(clock.current);
  assert.deepEqual(
    stuck.map((step) => step.stepId),
    [runningOverdue.stepId],
  );

  clock.advance(STUCK_QUEUED_MS);
  stuck = await store.findStuckSteps(clock.current);
  assert.deepEqual(
    stuck.map((step) => step.stepId),
    [runningOverdue.stepId, queuedOld.stepId],
  );
});

test('findStuckSteps excludes a queued step exactly at the ten minute boundary', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now, newId: createIds() });
  const run = await store.createRun(makeRunInput());
  const [step] = await store.createSteps(run.runId, [
    { title: 'Queued', workerType: 'research' },
  ]);

  assert.deepEqual(
    await store.findStuckSteps(step.createdAt + STUCK_QUEUED_MS),
    [],
  );
  assert.deepEqual(
    (
      await store.findStuckSteps(step.createdAt + STUCK_QUEUED_MS + 1)
    ).map((item) => item.stepId),
    [step.stepId],
  );
});

test('putEffectIfAbsent creates once and returns the original on duplicates', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now, newId: createIds() });

  const first = await store.putEffectIfAbsent({
    requestKey: 'request-1',
    runId: 'run-1',
    stepId: 'step-1',
    kind: 'createIssue',
    payload: { projectKey: 'TC', summary: 'Child issue' },
  });

  assert.equal(first.created, true);
  assert.equal(first.effect.requestKey, 'request-1');
  assert.equal(first.effect.status, 'pending');
  assert.equal(first.effect.tries, 0);
  assert.equal(first.effect.updatedAt, clock.current);
  assert.equal(first.effect.appliedAt, undefined);

  clock.advance(50);
  const duplicate = await store.putEffectIfAbsent({
    requestKey: 'request-1',
    runId: 'run-1',
    stepId: 'step-1',
    kind: 'createIssue',
    payload: { projectKey: 'TC', summary: 'Changed payload must not win' },
  });
  assert.equal(duplicate.created, false);
  assert.deepEqual(duplicate.effect, first.effect);
  assert.deepEqual(await store.getEffect('request-1'), first.effect);
  assert.equal(await store.getEffect('missing-effect'), null);
});

test('updateEffect merges patches and records appliedAt on apply', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now, newId: createIds() });
  await store.putEffectIfAbsent({
    requestKey: 'request-1',
    runId: 'run-1',
    kind: 'comment',
    payload: { issueKey: 'TC-2', bodyText: 'hello' },
  });

  clock.advance(10);
  const retrying = await store.updateEffect('request-1', {
    status: 'retrying',
    tries: 1,
  });
  assert.equal(retrying.status, 'retrying');
  assert.equal(retrying.tries, 1);
  assert.equal(retrying.updatedAt, clock.current);

  clock.advance(10);
  const applied = await store.updateEffect('request-1', {
    status: 'applied',
    tries: 2,
    result: { commentId: '10001' },
  });
  assert.equal(applied.status, 'applied');
  assert.deepEqual(applied.result, { commentId: '10001' });
  assert.equal(applied.appliedAt, clock.current);
  assert.equal(applied.updatedAt, clock.current);

  await assert.rejects(
    store.updateEffect('request-1', { requestKey: 'other' }),
    { name: 'StoreValidationError' },
  );
  await assert.rejects(store.updateEffect('missing', { status: 'failed' }), {
    name: 'NotFoundError',
  });
});

test('listEffectsByStatus uses the status index in updatedAt order', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now, newId: createIds() });

  await store.putEffectIfAbsent({
    requestKey: 'pending-1',
    runId: 'run-1',
    kind: 'comment',
    payload: { issueKey: 'TC-2', bodyText: 'one' },
  });
  clock.advance(10);
  await store.putEffectIfAbsent({
    requestKey: 'pending-2',
    runId: 'run-1',
    kind: 'comment',
    payload: { issueKey: 'TC-2', bodyText: 'two' },
  });
  clock.advance(10);
  await store.putEffectIfAbsent({
    requestKey: 'applied-1',
    runId: 'run-1',
    kind: 'transition',
    payload: { issueKey: 'TC-2', toStatusName: 'Done' },
    status: 'applied',
    result: { transitionId: '31' },
  });

  const pending = await store.listEffectsByStatus('pending');
  assert.deepEqual(
    pending.map((effect) => effect.requestKey),
    ['pending-1', 'pending-2'],
  );
  const applied = await store.listEffectsByStatus('applied');
  assert.deepEqual(
    applied.map((effect) => effect.requestKey),
    ['applied-1'],
  );
  assert.ok(applied[0].appliedAt > 0);
  assert.deepEqual(await store.listEffectsByStatus('applied', { limit: 0 }), []);
  await assert.rejects(store.listEffectsByStatus('bogus'), {
    name: 'StoreValidationError',
  });
});

test('putEffectIfAbsent requires a requestKey and a known kind', async () => {
  const store = createMemoryStore();
  await assert.rejects(
    store.putEffectIfAbsent({ kind: 'comment', payload: {} }),
    { name: 'StoreValidationError' },
  );
  await assert.rejects(
    store.putEffectIfAbsent({
      requestKey: 'request-1',
      kind: 'unknown',
      payload: {},
    }),
    { name: 'StoreValidationError' },
  );
});

test('addMemory uses memType and fills scope, validUntil, and createdAt', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now, newId: createIds() });

  const memory = await store.addMemory({
    projectKey: 'TC',
    type: 'decision',
    text: 'Refunds use the ledger service.',
    sourceIssue: 'TC-1',
    runId: 'run-1',
  });

  assert.equal(memory.memId, 'id-1');
  assert.equal(memory.memType, 'decision');
  assert.equal(memory.type, undefined);
  assert.equal(memory.scope, 'project');
  assert.equal(memory.validUntil, 0);
  assert.equal(memory.createdAt, clock.current);

  const explicit = await store.addMemory({
    memId: 'memory-explicit',
    projectKey: 'TC',
    scope: 'epic',
    memType: 'lesson',
    text: 'Check the payment gateway first.',
    validUntil: 123,
  });
  assert.equal(explicit.memId, 'memory-explicit');
  assert.equal(explicit.memType, 'lesson');
  assert.equal(explicit.scope, 'epic');
  assert.equal(explicit.validUntil, 123);
});

test('addMemory rejects conflicting or missing category fields', async () => {
  const store = createMemoryStore();
  await assert.rejects(
    store.addMemory({
      projectKey: 'TC',
      memType: 'decision',
      type: 'lesson',
      text: 'conflict',
    }),
    { name: 'StoreValidationError' },
  );
  await assert.rejects(
    store.addMemory({ projectKey: 'TC', text: 'no category' }),
    { name: 'StoreValidationError' },
  );
  await assert.rejects(
    store.addMemory({ projectKey: 'TC', memType: 'bogus', text: 'bad' }),
    { name: 'StoreValidationError' },
  );
});

test('listMemoriesByProject filters, sorts newest first, and honours limit', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now, newId: createIds() });

  const first = await store.addMemory({
    projectKey: 'TC',
    memType: 'decision',
    text: 'first',
  });
  clock.advance(10);
  const second = await store.addMemory({
    projectKey: 'TC',
    memType: 'lesson',
    text: 'second',
  });
  clock.advance(10);
  await store.addMemory({
    projectKey: 'OTHER',
    memType: 'fact',
    text: 'other project',
  });

  const memories = await store.listMemoriesByProject('TC');
  assert.deepEqual(
    memories.map((memory) => memory.memId),
    [second.memId, first.memId],
  );
  const limited = await store.listMemoriesByProject('TC', { limit: 1 });
  assert.deepEqual(
    limited.map((memory) => memory.memId),
    [second.memId],
  );
  assert.deepEqual(await store.listMemoriesByProject('TC', { limit: 0 }), []);
});

test('supersedeMemory links the replacement and keeps the old record listable', async () => {
  const store = createMemoryStore({ now: createClock().now, newId: createIds() });
  const oldMemory = await store.addMemory({
    projectKey: 'TC',
    memType: 'decision',
    text: 'old decision',
  });
  const newMemory = await store.addMemory({
    projectKey: 'TC',
    memType: 'decision',
    text: 'new decision',
  });

  const superseded = await store.supersedeMemory(
    oldMemory.memId,
    newMemory.memId,
  );
  assert.equal(superseded.supersededBy, newMemory.memId);

  const listed = await store.listMemoriesByProject('TC');
  assert.equal(
    listed.find((memory) => memory.memId === oldMemory.memId)?.supersededBy,
    newMemory.memId,
  );
  await assert.rejects(store.supersedeMemory('missing', newMemory.memId), {
    name: 'NotFoundError',
  });
});

test('values over 64 KiB are rejected with a clear ValueTooLargeError', async () => {
  const store = createMemoryStore();
  const tooLarge = bytesOfText(MAX_VALUE_BYTES + 1);

  await assert.rejects(store.createRun(makeRunInput({ goal: tooLarge })), (error) => {
    assert.ok(error instanceof ValueTooLargeError);
    assert.equal(error.name, 'ValueTooLargeError');
    assert.equal(error.code, 'VALUE_TOO_LARGE');
    assert.equal(error.entityName, 'run');
    assert.equal(error.field, 'goal');
    assert.equal(error.bytes, MAX_VALUE_BYTES + 1);
    assert.equal(error.limit, MAX_VALUE_BYTES);
    assert.match(error.message, /exceeds/);
    assert.match(error.message, /64 KiB/);
    return true;
  });

  const run = await store.createRun(makeRunInput());
  const [step] = await store.createSteps(run.runId, [
    { title: 'Research', workerType: 'research' },
  ]);
  await assert.rejects(
    store.updateStep(step.stepId, { output: tooLarge }),
    { name: 'ValueTooLargeError', field: 'output' },
  );
  await assert.rejects(
    store.putEffectIfAbsent({
      requestKey: 'request-1',
      kind: 'comment',
      payload: tooLarge,
    }),
    { name: 'ValueTooLargeError', field: 'payload' },
  );
  await assert.rejects(
    store.addMemory({
      projectKey: 'TC',
      memType: 'fact',
      text: tooLarge,
    }),
    { name: 'ValueTooLargeError', field: 'text' },
  );

  // Nothing invalid was persisted.
  assert.equal((await store.getRun(run.runId)).goal, run.goal);
  assert.equal((await store.getStep(step.stepId)).output, undefined);
  assert.equal(await store.getEffect('request-1'), null);
  assert.deepEqual(await store.listMemoriesByProject('TC'), []);
});

test('exactly 64 KiB is accepted and measured per value', async () => {
  const store = createMemoryStore();
  const atLimit = bytesOfText(MAX_VALUE_BYTES);

  const run = await store.createRun(makeRunInput());
  const [step] = await store.createSteps(run.runId, [
    { title: 'Research', workerType: 'research' },
  ]);
  const updated = await store.updateStep(step.stepId, { output: atLimit });
  assert.equal(updated.output.length, MAX_VALUE_BYTES);

  const effect = await store.putEffectIfAbsent({
    requestKey: 'request-at-limit',
    kind: 'comment',
    payload: atLimit,
  });
  assert.equal(effect.created, true);
  assert.equal(effect.effect.payload.length, MAX_VALUE_BYTES);

  const memory = await store.addMemory({
    projectKey: 'TC',
    memType: 'fact',
    text: atLimit,
  });
  assert.equal(memory.text.length, MAX_VALUE_BYTES);
});

test('NotFoundError carries the entity name and key', async () => {
  const store = createMemoryStore();
  await assert.rejects(store.updateStep('missing', {}), (error) => {
    assert.ok(error instanceof NotFoundError);
    assert.equal(error.entityName, 'step');
    assert.equal(error.key, 'missing');
    return true;
  });
});

test('StoreValidationError is exported and used for bad input', async () => {
  const store = createMemoryStore();
  await assert.rejects(store.createSteps('run-1', 'not-an-array'), (error) => {
    assert.ok(error instanceof StoreValidationError);
    assert.equal(error.code, 'VALIDATION');
    return true;
  });
});
