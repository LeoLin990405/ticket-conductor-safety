import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryStore } from '../../store/index.js';
import { stepWorkerHandler } from '../index.js';

test('CONDUCTOR_DEMO_STUCK_STEP hangs the claimed step before the worker runs', async () => {
  let now = 1_700_000_000_000;
  const store = createMemoryStore({ now: () => now });
  const run = await store.createRun({
    epicKey: 'TC-1',
    projectKey: 'TC',
    goal: 'Hang once',
    createdBy: 'account-1',
  });
  const [step] = await store.createSteps(run.runId, [
    { title: 'Research', workerType: 'research', input: 'refunds' },
  ]);

  let workerCalls = 0;
  let slept = 0;
  const result = await stepWorkerHandler(
    { body: { runId: run.runId, stepId: step.stepId, attempt: 0 } },
    {
      store,
      env: { CONDUCTOR_DEMO_STUCK_STEP: '1' },
      sleep: async (ms) => {
        slept = ms;
      },
      enqueueEffect: async () => {
        workerCalls += 1;
        return { requestKey: 'unused', created: true };
      },
      enqueueStep: async () => ({ jobId: 'job' }),
      jira: {
        async searchIssues() {
          workerCalls += 1;
          return [];
        },
        async getIssueLinks() {
          return [];
        },
      },
      now: () => now,
      logger: { info() {}, warn() {}, error() {} },
    },
  );

  assert.equal(result.status, 'demo-hang');
  assert.equal(workerCalls, 0);
  assert.ok(slept > 12 * 60 * 1000);
  const stored = await store.getStep(step.stepId);
  assert.equal(stored.status, 'running');
  assert.equal(stored.attempt, 0);
});
