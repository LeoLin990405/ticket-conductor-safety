import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createMemoryStore, resetStore, setStore } from '../../store/index.js';
import { resetWorkerTypes } from '../../worker/index.js';
import { handoffGoal } from '../handoff.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function installStore() {
  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  setStore(store);
  return store;
}

function queueStubs(store) {
  return {
    store,
    enqueueEffect: async () => ({ requestKey: 'k', created: true }),
    enqueueStep: async () => ({ jobId: 'job' }),
  };
}

test('handoffGoal recalls, plans, dispatches, and reads status', async () => {
  const store = installStore();
  try {
    await store.addMemory({
      projectKey: 'PAY',
      memType: 'decision',
      text: 'Refunds stay on the ledger',
      sourceIssue: 'PAY-9',
    });
    const result = await handoffGoal({
      epicKey: 'PAY-1',
      projectKey: 'PAY',
      goal: 'Ship payment refunds ledger',
      stepsJson: JSON.stringify([
        { title: 'Find related issues', workerType: 'research', input: 'refunds' },
      ]),
    }, { principal: { accountId: 'other-agent' } }, queueStubs(store));

    assert.equal(result.ok, true);
    assert.equal(result.status, 'running');
    assert.deepEqual(
      result.calls.map((call) => call.tool),
      ['recall-memory', 'plan-split', 'dispatch-run', 'get-run-status'],
    );
    assert.equal(result.calls[0].result.memories[0].memType, 'decision');
    assert.equal(result.calls[0].result.memories[0].sourceIssue, 'PAY-9');
    assert.equal(result.calls[1].result.ok, true);
    assert.equal(result.calls[1].result.status, 'planning');
    assert.equal(result.run.createdBy, undefined);
    assert.equal(result.steps[0].childIssueKey, null);
    assert.equal(result.steps[0].workerType, 'research');
    assert.equal(result.steps[0].attempt, 0);
    const stored = await store.getRun(result.runId);
    assert.equal(stored.createdBy, 'other-agent');
    assert.equal(stored.status, 'running');
  } finally {
    resetStore();
    resetWorkerTypes();
  }
});

test('handoffGoal does not dispatch an invalid plan', async () => {
  const store = installStore();
  try {
    const result = await handoffGoal({
      epicKey: 'PAY-1',
      projectKey: 'PAY',
      goal: 'Ship refunds',
      stepsJson: '[]',
    }, {}, queueStubs(store));
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'plan-split');
    assert.equal(result.code, 'VALIDATION');
    assert.deepEqual(result.calls.map((call) => call.tool), ['recall-memory']);
    assert.equal((await store.listRunsByEpic('PAY-1')).length, 0);
  } finally {
    resetStore();
    resetWorkerTypes();
  }
});

test('the local MCP client script hands off a goal and prints status', () => {
  const child = spawnSync(process.execPath, [
    'demo/mcp-client.mjs',
    '--local',
    '--epic',
    'PAY-12',
    '--project',
    'PAY',
    '--goal',
    'Ship payment refunds',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'running');
  assert.equal(result.run.epicKey, 'PAY-12');
  assert.equal(result.steps.length, 3);
  assert.deepEqual(result.steps.map((step) => step.dependsOn), [[], [0], [1]]);
  assert.equal(result.steps[0].status, 'queued');
  assert.equal(result.steps[1].status, 'waiting');
  assert.equal(result.steps[2].status, 'waiting');
  assert.equal(result.steps[0].childIssueKey, null);
});
