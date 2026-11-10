/**
 * Critical path, ETA, and the one-pair budget merge (novelty #6, second slice).
 *
 * The path is pure: no KVS, no model. `plan-split` is covered once at the
 * bottom so a short plan stays two steps when the store clock is not
 * `Date.now()`, and an over-budget chain actually shrinks before it is stored.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { getRunStatus, planSplit } from '../../actions/index.js';
import { createMemoryStore, resetStore, setStore } from '../../store/index.js';
import { resetWorkerTypes } from '../../worker/index.js';
import { initialRunBudget, RUN_WALL_CLOCK_MS } from '../budget.js';
import {
  OVER_CALLS,
  OVER_STEPS,
  OVER_WALL,
  REPLAN_MERGED,
  REPLAN_MERGED_STILL_OVER,
  REPLAN_NO_HELP,
  REPLAN_NO_PAIR,
  REPLAN_WITHIN_BUDGET,
  applyBudgetReplan,
  criticalPathOf,
  forecastBudget,
  plannedDurationMs,
  remainingWorkMs,
} from '../criticalPath.js';
import { STEP_DEADLINE_MS } from '../dependencies.js';

const NOW = 1_700_000_000_000;
const LONG = 70 * 60 * 1000;

function step(idx, workerType, dependsOn, extra = {}) {
  return {
    idx,
    title: extra.title || `${workerType}-${idx}`,
    workerType,
    input: extra.input === undefined ? '' : extra.input,
    dependsOn,
    ...extra,
    idx,
    workerType,
    dependsOn,
  };
}

test('the longest chain wins, and an equal diamond keeps the lower index', () => {
  const diamond = [
    step(0, 'research', []),
    step(1, 'research', []),
    step(2, 'draft-spec', [0, 1]),
  ];
  const tied = criticalPathOf(diamond, NOW);
  assert.deepEqual(tied.indexes, [0, 2]);
  assert.equal(tied.durationMs, 2 * STEP_DEADLINE_MS);

  const longer = [
    step(0, 'research', [], { durationMs: STEP_DEADLINE_MS }),
    step(1, 'research', [], { durationMs: 3 * STEP_DEADLINE_MS }),
    step(2, 'draft-spec', [0, 1]),
  ];
  const path = criticalPathOf(longer, NOW);
  assert.deepEqual(path.indexes, [1, 2]);
  assert.equal(path.durationMs, 4 * STEP_DEADLINE_MS);
  assert.deepEqual(path.keys, ['', '']);
});

test('a specific duration lives on the step or inside input, and keys follow stepId', () => {
  const steps = [
    step(0, 'research', [], { stepId: 's0', input: { text: 'a', durationMs: 5_000 } }),
    step(1, 'draft-spec', [0], { stepId: 's1', durationMs: 9_000, input: 'spec' }),
  ];
  assert.equal(plannedDurationMs(steps[0]), 5_000);
  assert.equal(plannedDurationMs(steps[1]), 9_000);
  const path = criticalPathOf(steps, NOW);
  assert.deepEqual(path.indexes, [0, 1]);
  assert.deepEqual(path.keys, ['s0', 's1']);
  assert.equal(path.durationMs, 14_000);
});

test('done work drops out, summarize adds nothing, and a waiting gate stays on the path', () => {
  const done = criticalPathOf([
    step(0, 'research', [], { status: 'done' }),
    step(1, 'draft-spec', [0], { status: 'queued' }),
    step(2, 'summarize', [1], { status: 'queued' }),
  ], NOW);
  assert.deepEqual(done.indexes, [1]);
  assert.equal(done.durationMs, STEP_DEADLINE_MS);

  const gate = criticalPathOf([
    step(0, 'research', [], { status: 'done' }),
    step(1, 'approval', [0], { status: 'waiting' }),
    step(2, 'draft-spec', [1], { status: 'waiting' }),
  ], NOW);
  assert.deepEqual(gate.indexes, [1, 2]);
  assert.equal(gate.durationMs, 2 * STEP_DEADLINE_MS);
});

test('a running step uses the time left on its deadline, unless the planner set one', () => {
  const running = step(0, 'research', [], {
    status: 'running',
    deadlineAt: NOW + 5 * 60 * 1000,
  });
  assert.equal(remainingWorkMs(running, NOW), 5 * 60 * 1000);
  assert.equal(criticalPathOf([running], NOW).durationMs, 5 * 60 * 1000);

  const overdue = step(0, 'research', [], {
    status: 'running',
    deadlineAt: NOW - 1,
  });
  assert.equal(remainingWorkMs(overdue, NOW), STEP_DEADLINE_MS);

  const custom = step(0, 'research', [], {
    status: 'running',
    deadlineAt: NOW + 1_000,
    durationMs: 50_000,
  });
  assert.equal(remainingWorkMs(custom, NOW), 50_000);
});

test('the ETA is the remaining path added to the caller clock', () => {
  const steps = [step(0, 'research', []), step(1, 'draft-spec', [0])];
  const forecast = forecastBudget(steps, initialRunBudget(NOW), NOW, { stepsAlreadyCounted: false });
  assert.equal(forecast.eta.remainingMs, 2 * STEP_DEADLINE_MS);
  assert.equal(forecast.eta.finishAt, NOW + 2 * STEP_DEADLINE_MS);
  assert.equal(forecast.budgetOutlook.over, false);
  assert.deepEqual(forecast.budgetOutlook.reasons, []);
});

test('eight serial default steps equal the wall-clock cap and are not merged', () => {
  const steps = [];
  for (let idx = 0; idx < 8; idx += 1) {
    steps.push(step(idx, 'research', idx === 0 ? [] : [idx - 1], { title: `Step ${idx}` }));
  }
  const forecast = forecastBudget(steps, initialRunBudget(NOW), NOW, { stepsAlreadyCounted: false });
  assert.equal(forecast.criticalPath.durationMs, RUN_WALL_CLOCK_MS);
  assert.equal(forecast.budgetOutlook.over, false);
  const replan = applyBudgetReplan(steps, initialRunBudget(NOW), NOW);
  assert.equal(replan.applied, false);
  assert.equal(replan.reason, REPLAN_WITHIN_BUDGET);
  assert.equal(replan.steps.length, 8);
});

test('an over-budget chain merges the pair that shortens the critical path', () => {
  const steps = [
    step(0, 'research', [], { title: 'Side A' }),
    step(1, 'research', [0], { title: 'Side B' }),
    step(2, 'research', [], { title: 'Scan refund issues' }),
    step(3, 'research', [2], { title: 'Scan ledger rows' }),
    step(4, 'draft-spec', [3], { title: 'Write the long spec', durationMs: LONG }),
    step(5, 'check-deps', [4], { title: 'Check capture links' }),
  ];
  const before = criticalPathOf(steps, NOW);
  assert.deepEqual(before.indexes, [2, 3, 4, 5]);
  assert.ok(before.durationMs > RUN_WALL_CLOCK_MS);

  const original = structuredClone(steps);
  const replan = applyBudgetReplan(steps, initialRunBudget(NOW), NOW);
  assert.deepEqual(steps, original);
  assert.equal(replan.applied, true);
  assert.equal(replan.reason, REPLAN_MERGED);
  assert.deepEqual(replan.mergedIdxs, [2, 3]);
  assert.equal(replan.steps.length, 5);
  assert.equal(replan.steps[2].title, 'Scan refund issues + Scan ledger rows');
  assert.equal(replan.steps[2].workerType, 'research');
  assert.equal(replan.steps[2].input.durationMs, STEP_DEADLINE_MS);
  assert.deepEqual(replan.steps[3].dependsOn, [2]);
  assert.deepEqual(replan.steps[4].dependsOn, [3]);
  assert.deepEqual(replan.criticalPath.indexes, [2, 3, 4]);
  assert.equal(replan.criticalPath.durationMs, STEP_DEADLINE_MS + LONG + STEP_DEADLINE_MS);
  assert.ok(replan.criticalPath.durationMs <= RUN_WALL_CLOCK_MS);
  assert.equal(replan.budgetOutlook.over, false);

  const again = applyBudgetReplan(replan.steps, initialRunBudget(NOW), NOW);
  assert.equal(again.applied, false);
  assert.equal(again.reason, REPLAN_WITHIN_BUDGET);
});

test('a single expensive step and a merge that would not shorten the path are left alone', () => {
  const alone = [step(0, 'draft-spec', [], { durationMs: 200 * 60 * 1000 })];
  const single = applyBudgetReplan(alone, initialRunBudget(NOW), NOW);
  assert.equal(single.applied, false);
  assert.equal(single.reason, REPLAN_NO_PAIR);
  assert.equal(single.steps.length, 1);
  assert.equal(single.budgetOutlook.reasons.includes(OVER_WALL), true);

  const parallel = [
    step(0, 'draft-spec', [], { durationMs: 200 * 60 * 1000, title: 'Long' }),
    step(1, 'research', [], { title: 'Cheap A' }),
    step(2, 'research', [], { title: 'Cheap B' }),
  ];
  const skipped = applyBudgetReplan(parallel, initialRunBudget(NOW), NOW);
  assert.equal(skipped.applied, false);
  assert.equal(skipped.reason, REPLAN_NO_HELP);
  assert.equal(skipped.steps.length, 3);
});

test('a step cap merges two sibling steps, and one merge can still leave the plan over', () => {
  const siblings = [
    step(0, 'research', [], { title: 'A' }),
    step(1, 'research', [], { title: 'B' }),
    step(2, 'research', [], { title: 'C' }),
  ];
  const tightSteps = {
    ...initialRunBudget(NOW),
    maxSteps: 2,
  };
  const joined = applyBudgetReplan(siblings, tightSteps, NOW);
  assert.equal(joined.applied, true);
  assert.equal(joined.reason, REPLAN_MERGED);
  assert.deepEqual(joined.mergedIdxs, [0, 1]);
  assert.equal(joined.steps.length, 2);
  assert.equal(joined.budgetOutlook.reasons.includes(OVER_STEPS), false);

  const chain = [
    step(0, 'research', [], { title: 'A' }),
    step(1, 'research', [0], { title: 'B' }),
    step(2, 'research', [1], { title: 'C' }),
  ];
  const tightClock = {
    ...initialRunBudget(NOW),
    wallClockMs: STEP_DEADLINE_MS + 1,
  };
  const still = applyBudgetReplan(chain, tightClock, NOW);
  assert.equal(still.applied, true);
  assert.equal(still.reason, REPLAN_MERGED_STILL_OVER);
  assert.equal(still.steps.length, 2);
  assert.deepEqual(still.budgetOutlook.reasons, [OVER_WALL]);
});

test('model-call pressure merges two adjacent workers and does not count an approval', () => {
  const chain = [
    step(0, 'research', [], { title: 'A' }),
    step(1, 'draft-spec', [0], { title: 'B' }),
  ];
  const tightCalls = {
    ...initialRunBudget(NOW),
    maxModelCalls: 1,
  };
  const joined = applyBudgetReplan(chain, tightCalls, NOW);
  assert.equal(joined.applied, true);
  assert.equal(joined.reason, REPLAN_MERGED);
  assert.equal(joined.steps.length, 1);
  assert.equal(joined.steps[0].workerType, 'research');
  assert.equal(joined.budgetOutlook.over, false);

  const gated = [
    step(0, 'research', [], { title: 'A' }),
    step(1, 'approval', [0], { title: 'Gate', status: 'waiting' }),
  ];
  const forecast = forecastBudget(gated, tightCalls, NOW, { stepsAlreadyCounted: false });
  assert.equal(forecast.projectedCalls, 1);
  assert.equal(forecast.budgetOutlook.reasons.includes(OVER_CALLS), false);
});

test('plan-split keeps a short plan and stores a merged plan without writing the path', async () => {
  const store = createMemoryStore({ now: () => NOW });
  setStore(store);
  try {
    const short = await planSplit({
      epicKey: 'PAY-1',
      projectKey: 'PAY',
      goal: 'Ship refunds',
      steps: [
        { title: 'Research', workerType: 'research', input: 'a', dependsOn: [] },
        { title: 'Draft', workerType: 'draft-spec', input: 'b', dependsOn: [0] },
      ],
    });
    assert.equal(short.ok, true, short.error);
    assert.equal(short.budgetReplan.applied, false);
    assert.equal(short.budgetReplan.reason, REPLAN_WITHIN_BUDGET);
    assert.equal(short.steps.length, 2);
    assert.equal(short.steps[0].input, 'a');
    assert.deepEqual(short.steps[1].dependsOn, [0]);

    const status = await getRunStatus({ runId: short.runId });
    assert.deepEqual(status.run.criticalPath.indexes, [0, 1]);
    assert.equal(status.run.eta.remainingMs, 2 * STEP_DEADLINE_MS);
    assert.equal(status.run.eta.finishAt, NOW + 2 * STEP_DEADLINE_MS);
    assert.equal(status.run.budgetOutlook.over, false);
    assert.equal(status.run.budget.maxSteps, 8);
    const stored = await store.getRun(short.runId);
    assert.equal(Object.hasOwn(stored.budget, 'criticalPath'), false);
    assert.equal(Object.hasOwn(stored, 'eta'), false);
    assert.equal(Object.hasOwn(stored, 'criticalPath'), false);
    const events = await store.listEventsByRun(short.runId);
    const created = events.find((event) => event.kind === 'plan.created');
    assert.equal(Object.hasOwn(created.detail, 'budgetReplan'), false);

    const over = await planSplit({
      epicKey: 'PAY-1',
      projectKey: 'PAY',
      goal: 'Ship the long refund spec',
      steps: [
        { title: 'Scan refund issues', workerType: 'research', input: 'refunds', dependsOn: [] },
        { title: 'Scan ledger rows', workerType: 'research', input: 'ledger', dependsOn: [0] },
        {
          title: 'Write the long spec',
          workerType: 'draft-spec',
          input: 'long spec',
          durationMs: LONG,
          dependsOn: [1],
        },
        { title: 'Check capture links', workerType: 'check-deps', input: 'links', dependsOn: [2] },
      ],
    }, {}, { now: () => NOW });
    assert.equal(over.ok, true, over.error);
    assert.equal(over.budgetReplan.applied, true);
    assert.equal(over.budgetReplan.reason, REPLAN_MERGED);
    assert.deepEqual(over.budgetReplan.mergedIdxs, [0, 1]);
    assert.equal(over.steps.length, 3);
    assert.equal(over.steps[0].title, 'Scan refund issues + Scan ledger rows');
    assert.equal(over.steps[0].input.merged, true);
    assert.equal(over.steps[1].input.durationMs, LONG);
    assert.deepEqual(over.steps[1].dependsOn, [0]);
    assert.deepEqual(over.steps[2].dependsOn, [1]);
    const overRun = await store.getRun(over.runId);
    assert.equal(overRun.status, 'planning');
    assert.equal(overRun.budget.usedSteps, 3);
    assert.equal(Object.hasOwn(overRun.budget, 'criticalPath'), false);

    const overStatus = await getRunStatus({ runId: over.runId }, {}, { now: () => NOW });
    assert.deepEqual(overStatus.run.criticalPath.indexes, [0, 1, 2]);
    assert.equal(
      overStatus.run.criticalPath.durationMs,
      STEP_DEADLINE_MS + LONG + STEP_DEADLINE_MS,
    );
    assert.equal(overStatus.run.eta.finishAt, NOW + overStatus.run.eta.remainingMs);
    assert.equal(overStatus.run.budgetOutlook.over, false);
    const storedSteps = await store.listSteps(over.runId);
    assert.deepEqual(
      overStatus.run.criticalPath.keys,
      storedSteps.map((row) => row.stepId),
    );
  } finally {
    resetStore();
    resetWorkerTypes();
  }
});
