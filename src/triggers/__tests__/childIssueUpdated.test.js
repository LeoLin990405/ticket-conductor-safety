import assert from 'node:assert/strict';
import test from 'node:test';

import { resetLocks } from '../../run/locks.js';
import { createHarness, startApproved } from '../../run/__tests__/harness.js';
import { createMemoryStore, resetStore, setStore } from '../../store/index.js';
import { resetWorkerTypes } from '../../worker/index.js';
import { childIssueUpdated } from '../childIssueUpdated.js';

test.afterEach(() => {
  resetWorkerTypes();
  resetLocks();
  resetStore();
});

test('a Done transition reports the matching child step', async () => {
  const harness = createHarness();
  const store = harness.store;
  const run = await harness.createRun();
  const [step] = await harness.createSteps(run.runId, [
    { title: 'Research', workerType: 'research' },
  ]);
  await store.updateStep(step.stepId, {
    status: 'running',
    attempt: 0,
    childIssueKey: 'PAY-2',
    deadlineAt: 1_700_000_100_000,
  });
  setStore(store);

  /** @type {object[]} */
  const reports = [];
  const result = await childIssueUpdated({
    eventType: 'avi:jira:updated:issue',
    issue: { key: 'PAY-2' },
    changelog: {
      items: [{ field: 'status', toString: 'Done' }],
    },
  }, {
    getStepByChildIssueKey: (key) => store.getStepByChildIssueKey(key),
    reportStep: async (stepId, report) => {
      reports.push(report);
      const updated = await store.updateStep(stepId, report);
      return { step: updated, run: await store.getRun(run.runId) };
    },
  });

  assert.equal(result.status, 'reported');
  assert.equal(result.approved, undefined);
  // A normal child is still a bare done. Approval metadata belongs to gates.
  assert.deepEqual(reports, [{ status: 'done' }]);
  const stored = await store.getStep(step.stepId);
  assert.equal(stored.status, 'done');
  assert.equal(stored.output?.approved, undefined);
});

test('transitioning an approval gate child to Done approves it once', async () => {
  const harness = createHarness();
  setStore(harness.store);
  const run = await harness.createRun();
  const steps = await harness.createSteps(run.runId, [
    { title: 'Approve the refund spec', workerType: 'approval', input: {}, dependsOn: [] },
    { title: 'Draft the refund spec', workerType: 'draft-spec', input: 'spec', dependsOn: [0] },
  ]);
  await startApproved(run.runId, harness.dependencies);
  const gate = await harness.store.getStep(steps[0].stepId);
  const draftBefore = await harness.store.getStep(steps[1].stepId);
  assert.equal(gate.status, 'waiting');
  assert.equal(draftBefore.status, 'waiting');
  assert.equal(typeof gate.childIssueKey, 'string');
  assert.equal(harness.stepEvents.length, 0);

  const event = {
    eventType: 'avi:jira:updated:issue',
    issue: { key: gate.childIssueKey },
    atlassianId: 'manager-1',
    changelog: {
      items: [{ field: 'status', fromString: 'To Do', toString: 'Done' }],
    },
  };
  const result = await childIssueUpdated(event, {
    leadDependencies: harness.dependencies,
  });
  assert.equal(result.status, 'reported');
  assert.equal(result.approved, true);
  assert.equal(result.duplicate, false);

  const approved = await harness.store.getStep(gate.stepId);
  assert.equal(approved.status, 'done');
  assert.equal(approved.attempt, 0);
  assert.equal(approved.output.approved, true);
  assert.equal(approved.output.actor, 'manager-1');
  assert.equal(approved.output.note, 'Transitioned to Done');
  assert.equal(approved.output.generator, 'human');
  const released = await harness.store.getStep(steps[1].stepId);
  assert.equal(released.status, 'queued');
  assert.equal(released.attempt, 0);
  assert.equal(harness.stepEvents.length, 1);
  assert.equal(harness.stepEvents[0].stepId, steps[1].stepId);

  const again = await childIssueUpdated(event, {
    leadDependencies: harness.dependencies,
  });
  assert.equal(again.status, 'reported');
  assert.equal(again.duplicate, true);
  assert.equal(again.approved, true);
  assert.equal(harness.stepEvents.length, 1);
  const still = await harness.store.getStep(gate.stepId);
  assert.equal(still.output.actor, 'manager-1');
  assert.equal((await harness.store.getStep(steps[1].stepId)).status, 'queued');
});

test('a Closed transition uses the same approval path', async () => {
  const harness = createHarness();
  setStore(harness.store);
  const run = await harness.createRun();
  const [gate] = await harness.createSteps(run.runId, [
    { title: 'Approve blast radius', workerType: 'approval', input: {}, dependsOn: [] },
  ]);
  await startApproved(run.runId, harness.dependencies);
  const stored = await harness.store.getStep(gate.stepId);
  const result = await childIssueUpdated({
    eventType: 'avi:jira:updated:issue',
    issue: { key: stored.childIssueKey },
    user: { accountId: 'manager-2' },
    changelog: { items: [{ field: 'status', toString: 'Closed' }] },
  }, { leadDependencies: harness.dependencies });
  assert.equal(result.approved, true);
  assert.equal(result.duplicate, false);
  const done = await harness.store.getStep(gate.stepId);
  assert.equal(done.status, 'done');
  assert.equal(done.output.actor, 'manager-2');
  assert.equal(done.output.generator, 'human');
  assert.equal(done.output.note, 'Transitioned to Closed');
});

test('a non-done transition and a failed gate do not approve', async () => {
  const harness = createHarness();
  setStore(harness.store);
  const run = await harness.createRun();
  const [gate, failed] = await harness.createSteps(run.runId, [
    { title: 'Approve the refund spec', workerType: 'approval', input: {}, dependsOn: [] },
    { title: 'Approve a blocked change', workerType: 'approval', input: {}, dependsOn: [] },
  ]);
  await startApproved(run.runId, harness.dependencies);
  const waiting = await harness.store.getStep(gate.stepId);
  const blocked = await harness.store.getStep(failed.stepId);
  await harness.store.updateStep(blocked.stepId, { status: 'failed' });

  const progress = await childIssueUpdated({
    eventType: 'avi:jira:updated:issue',
    issue: { key: waiting.childIssueKey },
    atlassianId: 'manager-1',
    changelog: { items: [{ field: 'status', toString: 'In Progress' }] },
  }, { leadDependencies: harness.dependencies });
  assert.equal(progress.status, 'ignored');
  assert.equal(progress.reason, 'no-matching-change');
  assert.equal((await harness.store.getStep(waiting.stepId)).status, 'waiting');
  assert.equal(harness.stepEvents.length, 0);

  const rejected = await childIssueUpdated({
    eventType: 'avi:jira:updated:issue',
    issue: { key: blocked.childIssueKey },
    atlassianId: 'manager-1',
    changelog: { items: [{ field: 'status', toString: 'Done' }] },
  }, { leadDependencies: harness.dependencies });
  assert.equal(rejected.status, 'ignored');
  assert.equal(rejected.reason, 'approval-not-applied');
  assert.equal((await harness.store.getStep(blocked.stepId)).status, 'failed');
});

test('an unrelated issue is ignored', async () => {
  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  const result = await childIssueUpdated({
    eventType: 'avi:jira:updated:issue',
    issue: { key: 'PAY-99' },
    changelog: { items: [{ field: 'status', toString: 'Done' }] },
  }, {
    getStepByChildIssueKey: (key) => store.getStepByChildIssueKey(key),
    reportStep: async () => {
      throw new Error('should not report');
    },
  });
  assert.equal(result.status, 'ignored');
});
