import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryStore, listRunsByEpic, resetStore, setStore } from '../../store/index.js';
import { resetWorkerTypes } from '../../worker/index.js';
import { getRunStatus, parsePlanSteps, planSplit } from '../index.js';

function installStore() {
  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  setStore(store);
  return store;
}

test('parsePlanSteps keeps dependsOn and rejects a cycle before any run exists', async () => {
  const steps = parsePlanSteps(JSON.stringify([
    { title: 'Research', workerType: 'research', input: 'refunds', dependsOn: [] },
    { title: 'Draft', workerType: 'draft-spec', input: 'spec', dependsOn: [0] },
  ]));
  assert.deepEqual(steps[1].dependsOn, [0]);
  assert.deepEqual(steps[0].dependsOn, []);

  const store = installStore();
  try {
    await assert.rejects(
      () => planSplit({
        epicKey: 'PAY-1',
        projectKey: 'PAY',
        goal: 'Ship refunds',
        stepsJson: JSON.stringify([
          { title: 'A', workerType: 'research', input: 'a', dependsOn: [1] },
          { title: 'B', workerType: 'draft-spec', input: 'b', dependsOn: [0] },
        ]),
      }),
      /cycle/,
    );
    assert.deepEqual(await listRunsByEpic('PAY-1'), []);
    assert.equal(await store.listRunsByEpic('PAY-1').then((runs) => runs.length), 0);
  } finally {
    resetStore();
    resetWorkerTypes();
  }
});

test('planSplit stores dependsOn and getRunStatus returns it', async () => {
  installStore();
  try {
    const planned = await planSplit({
      epicKey: 'PAY-1',
      projectKey: 'PAY',
      goal: 'Ship refunds',
      steps: [
        { title: 'Research A', workerType: 'research', input: 'a' },
        { title: 'Research B', workerType: 'research', input: 'b', dependsOn: [] },
        { title: 'Draft', workerType: 'draft-spec', input: 'spec', dependsOn: [0, 1] },
      ],
    });
    assert.deepEqual(planned.steps.map((step) => step.dependsOn), [[], [], [0, 1]]);
    const status = await getRunStatus({ runId: planned.runId });
    assert.deepEqual(status.steps[2].dependsOn, [0, 1]);
    assert.equal(status.steps[2].status, 'queued');
  } finally {
    resetStore();
    resetWorkerTypes();
  }
});
