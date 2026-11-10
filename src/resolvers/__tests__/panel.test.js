import assert from 'node:assert/strict';
import test from 'node:test';

import { STEP_DEADLINE_MS } from '../../run/dependencies.js';
import { createMemoryStore, resetStore, setStore } from '../../store/index.js';
import { issueKeyFrom, loadRun, loadRunsForIssue } from '../panelData.js';

test('issueKeyFrom prefers the payload and falls back to the Forge context', () => {
  assert.equal(issueKeyFrom({ payload: { issueKey: 'PAY-1' } }), 'PAY-1');
  assert.equal(issueKeyFrom({
    context: { extension: { issue: { key: 'PAY-2' } } },
  }), 'PAY-2');
  assert.equal(issueKeyFrom({}), '');
});

test('loadRunsForIssue and loadRun return the epic run, steps, and effects', async () => {
  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  setStore(store);
  try {
    const run = await store.createRun({
      epicKey: 'PAY-1',
      projectKey: 'PAY',
      goal: 'Ship refunds',
      createdBy: 'acct',
    });
    await store.createSteps(run.runId, [
      { title: 'Research', workerType: 'research' },
    ]);
    await store.putEffectIfAbsent({
      requestKey: 'effect-1',
      runId: run.runId,
      kind: 'comment',
      payload: { issueKey: 'PAY-1', bodyText: 'hello' },
    });
    await store.addMemory({
      projectKey: 'PAY',
      memType: 'decision',
      text: 'Keep the ledger',
      sourceIssue: 'PAY-1',
      runId: run.runId,
    });

    const listed = await loadRunsForIssue('PAY-1');
    assert.equal(listed.runs.length, 1);
    assert.equal(listed.runs[0].goal, 'Ship refunds');

    const detail = await loadRun(run.runId);
    assert.equal(detail.steps.length, 1);
    assert.deepEqual(detail.events, []);
    assert.deepEqual(detail.timeline, []);
    assert.equal(detail.effects.length, 1);
    assert.equal(detail.effects[0].kind, 'comment');
    assert.equal(detail.memories[0].memType, 'decision');
    assert.deepEqual(detail.schedule.criticalPath.indexes, [0]);
    assert.equal(detail.schedule.eta.remainingMs, STEP_DEADLINE_MS);
    assert.equal(detail.schedule.budgetOutlook.over, false);
    assert.equal(Object.hasOwn(detail.run, 'criticalPath'), false);
    assert.deepEqual(detail.chaos, { injected: 0, healed: 0, duplicateWrites: 0 });
    assert.deepEqual(detail.effectMetrics, { applied: 0, deduped: 0, retried: 0 });
    assert.equal(Object.hasOwn(detail.run.budget, 'chaos'), false);
    assert.equal(detail.blast.title, 'Blast radius');
    assert.equal(detail.blast.appearance, 'information');
    assert.equal(
      detail.blast.summary,
      '1 child issues, 2 comments (1 after the run finishes), 0 transitions, 0 field changes',
    );
    assert.equal(typeof detail.blast.rows[0].cells[0].content, 'string');
    assert.deepEqual(await loadRunsForIssue(''), { issueKey: '', runs: [] });
  } finally {
    resetStore();
  }
});
