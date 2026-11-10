import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryStore, StoreValidationError } from '../index.js';

test('createSteps stores dependsOn and updateStep can claim a waiting row once', async () => {
  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  const run = await store.createRun({
    epicKey: 'PAY-1',
    projectKey: 'PAY',
    goal: 'Ship refunds',
    createdBy: 'acct',
  });
  const [root, child] = await store.createSteps(run.runId, [
    { title: 'Research', workerType: 'research', input: 'x' },
    { title: 'Draft', workerType: 'draft-spec', dependsOn: [0] },
  ]);
  assert.deepEqual(root.dependsOn, []);
  assert.deepEqual(child.dependsOn, [0]);

  const waiting = await store.updateStep(
    child.stepId,
    { status: 'waiting' },
    { expectedStatus: 'queued' },
  );
  assert.equal(waiting.status, 'waiting');

  const lost = await store.updateStep(
    child.stepId,
    { status: 'waiting' },
    { expectedStatus: 'queued' },
  );
  assert.equal(lost, null);
  assert.equal((await store.getStep(child.stepId)).status, 'waiting');

  await assert.rejects(
    () => store.updateStep(child.stepId, { dependsOn: [] }),
    (error) => error instanceof StoreValidationError,
  );
  await assert.rejects(
    () => store.createSteps(run.runId, [
      { title: 'Bad', workerType: 'research', dependsOn: ['0'] },
    ]),
    /dependsOn/,
  );
});
