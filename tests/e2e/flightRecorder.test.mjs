/**
 * End-to-end flight recorder on the fake Forge runtime.
 *
 * A seeded plan is dispatched with the deterministic workers. Replay then
 * re-reads Jira and must not add a mutation. Fork copies the prefix and
 * creates a child issue only for the downstream step.
 */

import assert from 'node:assert/strict';

import { forkRun } from '../../src/recorder/fork.js';
import { replayRun } from '../../src/recorder/replay.js';
import { planSplit } from '../../src/actions/index.js';

import {
  createWorld,
  dispatchAndDrain,
  testSerial,
} from './harness.mjs';

testSerial('replay diffs today\'s Jira with zero duplicate writes, then fork re-runs downstream only', async () => {
  const world = await createWorld();
  try {
    const planned = await planSplit({
      epicKey: 'PAY-1',
      projectKey: 'PAY',
      goal: 'Ship payment refunds',
      steps: [
        { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
        { title: 'Draft the refund API', workerType: 'draft-spec', input: 'idempotent on the payment id', dependsOn: [0] },
        { title: 'Check the capture dependency', workerType: 'check-deps', input: 'capture', dependsOn: [1] },
      ],
    }, { principal: { accountId: 'account-demo' } });

    const eventsAfterPlan = await world.store.listEventsByRun(planned.runId);
    assert.ok(eventsAfterPlan.some((event) => event.kind === 'plan.created'));
    assert.equal(
      eventsAfterPlan.filter((event) => event.kind === 'step.queued').length,
      3,
    );
    assert.equal(world.jira.mutationsOf('createIssue').length, 0);

    await dispatchAndDrain(world, planned.runId);
    const finished = await world.store.getRun(planned.runId);
    assert.equal(finished.status, 'done');
    const issueCount = world.jira.mutationsOf('createIssue').length;
    assert.equal(issueCount, 3);
    const mutationCount = world.jira.calls.filter((call) => call.method !== 'GET').length;

    const replay = await replayRun(planned.runId, {
      store: world.store,
      jira: world.dependencies.jira,
      now: () => world.clock.now,
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(replay.dryRun, true);
    assert.equal(replay.duplicateWrites, 0);
    assert.match(replay.summary, /today's Jira/);
    assert.ok(replay.effects.some((effect) => effect.verdict === 'already-applied-skipped'));
    assert.equal(
      world.jira.calls.filter((call) => call.method !== 'GET').length,
      mutationCount,
    );
    assert.equal((await world.store.listSteps(planned.runId)).length, 4);

    const journalled = (await world.store.listEventsByRun(planned.runId))
      .filter((event) => event.kind === 'effect.written' && event.detail?.phase === 'applied');
    assert.ok(journalled.length >= 3);
    assert.ok(journalled.every((event) => typeof event.journalKey === 'string' && event.journalKey.length > 0));
    assert.ok(journalled.every((event) => event.span['gen_ai.request.model'] === 'deterministic-fallback'));
    assert.equal('eventId' in journalled[0], true);
    const stored = world.sdk.debug.get('event', journalled[0].eventId);
    assert.equal('eventId' in stored, false);

    const originalSteps = await world.store.listSteps(planned.runId);
    const forked = await forkRun({
      runId: planned.runId,
      stepIdx: 1,
      createdBy: 'account-demo',
    }, world.dependencies);
    assert.deepEqual(forked.copy, [0, 1]);
    assert.deepEqual(forked.rerun, [2]);
    await world.drainAll();

    assert.equal(world.jira.mutationsOf('createIssue').length, issueCount + 1);
    const forkSteps = await world.store.listSteps(forked.runId);
    assert.equal(forkSteps.find((step) => step.idx === 0).status, 'done');
    assert.equal(forkSteps.find((step) => step.idx === 0).childIssueKey, originalSteps.find((step) => step.idx === 0).childIssueKey);
    assert.equal(forkSteps.find((step) => step.idx === 1).status, 'done');
    const rerun = forkSteps.find((step) => step.idx === 2 && step.workerType === 'check-deps');
    assert.equal(rerun.status, 'done');
    assert.notEqual(rerun.childIssueKey, originalSteps.find((step) => step.idx === 2).childIssueKey);

    const afterReplay = world.jira.mutationsOf('createIssue').length;
    const again = await replayRun(forked.runId, {
      store: world.store,
      jira: world.dependencies.jira,
      now: () => world.clock.now,
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(again.duplicateWrites, 0);
    assert.equal(world.jira.mutationsOf('createIssue').length, afterReplay);
  } finally {
    await world.close();
  }
});
