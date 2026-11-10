import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryStore } from '../index.js';

// Regression for run 712a7626: the worker marked the research step `done`
// while the effect applier recorded `childIssueKey` from a stale `running`
// snapshot. The blind write put the step back to `running` with no output.
test('concurrent updateStep calls do not overwrite a newer status', async () => {
  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  const run = await store.createRun({
    epicKey: 'TD-1',
    projectKey: 'TD',
    goal: 'race',
    createdBy: 'tester',
  });
  const [step] = await store.createSteps(run.runId, [
    { title: 'Research', workerType: 'research', input: 'x' },
  ]);
  await store.updateStep(step.stepId, { status: 'running', attempt: 0 });

  await Promise.all([
    store.updateStep(step.stepId, { status: 'done', output: { count: 0 } }),
    store.updateStep(step.stepId, { childIssueKey: 'TD-8' }),
  ]);

  const final = await store.getStep(step.stepId);
  assert.equal(final.status, 'done');
  assert.deepEqual(final.output, { count: 0 });
  assert.equal(final.childIssueKey, 'TD-8');
});
