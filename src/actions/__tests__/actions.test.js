import assert from 'node:assert/strict';
import test from 'node:test';

import { requestKeyFor } from '../../effects/requestKey.js';
import { issueHumanConfirmation } from '../../safety/grants.js';
import { createMemoryStore, resetStore, setStore } from '../../store/index.js';
import { resetWorkerTypes } from '../../worker/index.js';
import {
  dispatchRun,
  getRunStatus,
  parsePlanSteps,
  planSplit,
  recallMemory,
  recordDecision,
} from '../index.js';

function installStore() {
  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  setStore(store);
  return store;
}

test('parsePlanSteps accepts an approval gate and a five-step plan grows one', async () => {
  const steps = parsePlanSteps(JSON.stringify([
    { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
    { title: 'Approve the spec', workerType: 'approval', input: '', dependsOn: [] },
    { title: 'Draft the spec', workerType: 'draft-spec', input: 'spec', dependsOn: [1] },
  ]));
  assert.equal(steps[1].workerType, 'approval');
  assert.deepEqual(steps[2].dependsOn, [1]);

  const store = installStore();
  try {
    const planned = await planSplit({
      epicKey: 'PAY-1',
      projectKey: 'PAY',
      goal: 'Ship payment refunds',
      steps: Array.from({ length: 5 }, (_, index) => ({
        title: `Step ${index}`,
        workerType: index === 2 ? 'draft-spec' : 'research',
        input: 'refunds',
        dependsOn: [],
      })),
    });
    assert.equal(planned.ok, true);
    assert.equal(planned.steps.length, 6);
    assert.equal(planned.steps[5].workerType, 'approval');
    assert.equal(planned.steps[5].title, 'Approve blast radius');
    assert.deepEqual(planned.steps[5].dependsOn, []);
    for (let index = 0; index < 5; index += 1) {
      assert.ok(planned.steps[index].dependsOn.includes(5), `step ${index} waits on the gate`);
    }
    assert.equal(planned.blastRadius.risk.score >= 5, true);
    assert.equal(planned.blastRadius.gate.insert, false);
    assert.match(planned.blastRadius.gate.reason, /already in the plan/);
    const stored = await store.listSteps(planned.runId);
    assert.equal(stored.length, 6);
  } finally {
    resetStore();
    resetWorkerTypes();
  }
});

test('parsePlanSteps accepts a JSON string and rejects an unknown worker', () => {
  const steps = parsePlanSteps(JSON.stringify([
    { title: 'Research refunds', workerType: 'research', input: 'label = refunds' },
  ]));
  assert.equal(steps[0].workerType, 'research');
  assert.throws(
    () => parsePlanSteps(JSON.stringify([
      { title: 'Nope', workerType: 'agent-b', input: '' },
    ])),
    /workerType/,
  );
  assert.throws(
    () => parsePlanSteps(JSON.stringify(Array.from({ length: 9 }, (_, index) => ({
      title: `Step ${index}`,
      workerType: 'research',
      input: '',
    })))),
    /1 to 8/,
  );
});

test('planSplit stores a run and recalls an earlier decision', async () => {
  const store = installStore();
  try {
    await store.addMemory({
      projectKey: 'PAY',
      memType: 'decision',
      text: 'Refunds stay on the ledger',
      sourceIssue: 'PAY-9',
    });
    const result = await planSplit({
      epicKey: 'PAY-1',
      goal: 'Ship payment refunds ledger',
      stepsJson: JSON.stringify([
        { title: 'Find related issues', workerType: 'research', input: 'refunds' },
        { title: 'Draft the spec', workerType: 'draft-spec', input: 'ledger' },
      ]),
    }, { principal: { accountId: 'acct-1' } });

    assert.equal(result.steps.length, 2);
    assert.equal(result.recalledMemories.length, 1);
    assert.equal(result.recalledMemories[0].memType, 'decision');
    const run = await store.getRun(result.runId);
    assert.equal(run.status, 'planning');
    assert.equal(run.createdBy, 'acct-1');
    assert.equal(run.projectKey, 'PAY');
    assert.equal(run.blastRadius, undefined);
    assert.equal(result.blastRadius.phase, 'preview');
    assert.equal(result.blastRadius.counts.issues, 2);
    assert.equal(result.blastRadius.gate.insert, false);
    const effects = await store.listEffectsByRun(result.runId);
    assert.equal(effects.length, 0);
  } finally {
    resetStore();
    resetWorkerTypes();
  }
});

test('dispatchRun returns the preview computed before enqueue and does not call Jira', async () => {
  const store = installStore();
  /** @type {string[]} */
  const jiraCalls = [];
  /** @type {object[]} */
  const enqueued = [];
  try {
    const planned = await planSplit({
      epicKey: 'PAY-1',
      projectKey: 'PAY',
      goal: 'Ship refunds',
      steps: [{ title: 'Research refunds', workerType: 'research', input: 'x' }],
    });
    assert.equal(planned.blastRadius.phase, 'preview');
    assert.equal(planned.confirmToken, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(planned, 'confirmToken'), false);
    assert.match(planned.acknowledgement, /points/);
    const issued = await issueHumanConfirmation({
      runId: planned.runId,
      store,
      now: () => 1_700_000_000_000,
      principal: 'person',
    });
    assert.equal(issued.ok, true);
    const refused = await dispatchRun(
      { runId: planned.runId, confirm: true },
      {},
      {
        store,
        now: () => 1_700_000_000_000,
        enqueueEffect: async () => {
          throw new Error('an unconfirmed dispatch must not enqueue');
        },
        enqueueStep: async () => {
          throw new Error('an unconfirmed dispatch must not enqueue');
        },
      },
    );
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'CONFIRMATION_REQUIRED');
    assert.equal(refused.status, 'planning');
    const started = await dispatchRun(
      {
        runId: planned.runId,
        confirm: true,
        acknowledgeBlastRadius: issued.acknowledgement,
        confirmToken: issued.confirmToken,
      },
      {},
      {
        store,
        now: () => 1_700_000_000_000,
        enqueueEffect: async (effect) => {
          enqueued.push(effect);
          return { requestKey: 'k', created: true };
        },
        enqueueStep: async () => ({ jobId: 'job' }),
        requestJira: async (path) => {
          jiraCalls.push(String(path));
          throw new Error('dispatch must not call Jira while previewing');
        },
      },
    );
    assert.deepEqual(jiraCalls, []);
    assert.equal(started.status, 'running');
    assert.equal(started.blastRadius.phase, 'preview');
    const previewKey = started.blastRadius.writes.find((write) => write.kind === 'createIssue').requestKey;
    assert.equal(previewKey, planned.blastRadius.writes.find((write) => write.kind === 'createIssue').requestKey);
    assert.equal(previewKey, requestKeyFor({
      runId: planned.runId,
      stepId: planned.steps[0].stepId,
      kind: 'createIssue',
      discriminator: 'child-issue',
    }));
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].kind, 'createIssue');
    assert.equal(enqueued[0].discriminator, 'child-issue');
    const stored = await store.getRun(planned.runId);
    assert.equal(stored.blastRadius, undefined);
  } finally {
    resetStore();
  }
});

test('dispatchRun ignores a second call once the run is running', async () => {
  const store = installStore();
  try {
    const planned = await planSplit({
      epicKey: 'PAY-1',
      projectKey: 'PAY',
      goal: 'Ship refunds',
      steps: [{ title: 'Research', workerType: 'research', input: 'x' }],
    });
    const overrides = {
      store,
      now: () => 1_700_000_000_000,
      enqueueEffect: async () => ({ requestKey: 'k', created: true }),
      enqueueStep: async () => ({ jobId: 'job' }),
    };
    const issued = await issueHumanConfirmation({
      runId: planned.runId,
      store,
      now: () => 1_700_000_000_000,
      principal: 'person',
    });
    const started = await dispatchRun(
      {
        runId: planned.runId,
        confirm: true,
        acknowledgeBlastRadius: issued.acknowledgement,
        confirmToken: issued.confirmToken,
      },
      {},
      overrides,
    );
    assert.equal(started.status, 'running');
    const again = await dispatchRun(
      { runId: planned.runId },
      {},
      overrides,
    );
    assert.equal(again.status, 'running');
    const steps = await store.listSteps(planned.runId);
    assert.equal(steps.length, 1);
  } finally {
    resetStore();
  }
});

test('getRunStatus returns the latest run for an epic', async () => {
  installStore();
  try {
    await planSplit({
      epicKey: 'PAY-1',
      projectKey: 'PAY',
      goal: 'First',
      steps: [{ title: 'Research', workerType: 'research', input: '' }],
    });
    const status = await getRunStatus({ epicKey: 'PAY-1' });
    assert.equal(status.run.goal, 'First');
    assert.equal(status.steps[0].title, 'Research');
    assert.equal(status.steps[0].attempt, 0);
    assert.equal(status.steps[0].input, undefined);
    assert.equal(status.blastRadius.phase, 'preview');
    assert.equal(status.blastRadius.counts.issues, 1);
    assert.deepEqual(status.run.effectMetrics, { applied: 0, deduped: 0, retried: 0 });
  } finally {
    resetStore();
  }
});

test('recordDecision stores type as memType and recall returns it', async () => {
  const store = installStore();
  try {
    const recorded = await recordDecision({
      epicKey: 'PAY-1',
      projectKey: 'PAY',
      text: 'Callbacks must be idempotent',
      type: 'lesson',
    });
    const memory = await store.listMemoriesByProject('PAY');
    assert.equal(memory.length, 1);
    assert.equal(memory[0].memId, recorded.memId);
    assert.equal(memory[0].memType, 'lesson');
    assert.equal(memory[0].type, undefined);
    const recalled = await recallMemory({
      projectKey: 'PAY',
      query: 'idempotent callbacks',
    });
    assert.equal(recalled.memories[0].memType, 'lesson');
  } finally {
    resetStore();
  }
});

test('actionHandler returns a JSON error instead of throwing', async () => {
  const { actionHandler } = await import('../index.js');
  const origErr = console.error; const origLog = console.log;
  console.error = () => {}; console.log = () => {};
  try {
    const wrapped = actionHandler(async () => { throw new Error('boom'); }, 'x');
    const result = await wrapped({ runId: 'r' }, {});
    assert.equal(result.ok, false);
    assert.equal(result.error, 'boom');
  } finally { console.error = origErr; console.log = origLog; }
});

test('parsePlanSteps accepts 1 and 2 step plans and rejects an empty plan', () => {
  const one = parsePlanSteps(JSON.stringify([
    { title: 'Research', workerType: 'research', input: 'project TD' },
  ]));
  assert.equal(one.length, 1);
  const two = parsePlanSteps(JSON.stringify([
    { title: 'Research', workerType: 'research', input: 'project TD' },
    { title: 'Spec', workerType: 'draft-spec', input: 'one page' },
  ]));
  assert.equal(two.length, 2);
  assert.throws(() => parsePlanSteps('[]'), /1 to 8/);
});
