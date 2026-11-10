/**
 * Run budget (novelty #6, first slice).
 *
 * The store records caps and usage. Nothing here computes a critical path,
 * an ETA, or a re-plan. A counter past its cap stays on the row and leaves
 * the run status alone.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryStore } from '../../store/index.js';
import { completeText } from '../../worker/llm.js';
import { STEP_DEADLINE_MS } from '../dependencies.js';
import { MAX_STEPS, MAX_WAVES } from '../digest.js';
import {
  RUN_MAX_MODEL_CALLS,
  RUN_MAX_STEPS,
  RUN_WALL_CLOCK_MS,
  applyRunBudget,
  commitRunBudget,
  initialRunBudget,
  isWithinRunBudget,
  noteModelResult,
  readRunBudget,
} from '../budget.js';

const STARTED = 1_700_000_000_000;

function runInput() {
  return {
    epicKey: 'PAY-1',
    projectKey: 'PAY',
    goal: 'Ship payment refunds',
    createdBy: 'account-1',
  };
}

test('the caps match the step limit, the attempt limit, and the 12 minute deadline', () => {
  assert.equal(RUN_MAX_STEPS, MAX_STEPS);
  assert.equal(RUN_MAX_STEPS, 8);
  assert.equal(RUN_MAX_MODEL_CALLS, MAX_STEPS * 3 + MAX_WAVES + 1);
  assert.equal(RUN_MAX_MODEL_CALLS, 28);
  assert.equal(RUN_WALL_CLOCK_MS, MAX_STEPS * STEP_DEADLINE_MS);
  assert.equal(RUN_WALL_CLOCK_MS, 8 * 12 * 60 * 1000);
  const budget = initialRunBudget(STARTED);
  assert.equal(budget.startedAt, STARTED);
  assert.equal(budget.usedSteps, 0);
  assert.equal(budget.usedModelCalls, 0);
  assert.equal(budget.usedTokens, 0);
  assert.equal(budget.elapsedMs, 0);
  assert.equal(isWithinRunBudget(budget), true);
  assert.equal(Object.hasOwn(budget, 'criticalPath'), false);
  assert.equal(Object.hasOwn(budget, 'eta'), false);
});

test('createRun stores the budget and summarize does not consume a step', async () => {
  let now = STARTED;
  const store = createMemoryStore({ now: () => now });
  const run = await store.createRun(runInput());
  assert.deepEqual(run.budget, initialRunBudget(STARTED));

  await store.createSteps(run.runId, [
    { title: 'Research refunds', workerType: 'research', input: 'refunds' },
    { title: 'Draft the spec', workerType: 'draft-spec', input: 'spec', dependsOn: [0] },
  ]);
  const planned = await store.getRun(run.runId);
  assert.equal(planned.budget.usedSteps, 2);
  assert.equal(planned.status, 'planning');

  now += 60_000;
  await store.createSteps(run.runId, [
    { title: 'Summarize run', workerType: 'summarize', input: { auto: true } },
  ]);
  const withCloser = await store.getRun(run.runId);
  assert.equal(withCloser.budget.usedSteps, 2);
  // The closer added no work step, so the clock was not rewritten either.
  assert.equal(withCloser.budget.elapsedMs, 0);
  assert.equal(withCloser.budget.usedModelCalls, 0);
});

test('a disabled model is not a call, and a thrown chat is', async () => {
  const disabled = { calls: 0, tokens: 0 };
  const off = await completeText(
    { system: 'rules', user: 'data', meter: disabled },
    { disabled: true },
  );
  assert.equal(off.ok, false);
  assert.equal(off.reason, 'disabled');
  assert.equal(disabled.calls, 0);
  assert.equal(disabled.tokens, 0);

  const thrown = { calls: 0, tokens: 0 };
  const failed = await completeText(
    { system: 'rules', user: 'data', meter: thrown },
    {
      async chat() {
        throw new Error('Forge LLM quota exceeded');
      },
    },
  );
  assert.equal(failed.reason, 'error');
  assert.equal(thrown.calls, 1);
  assert.equal(thrown.tokens, 0);

  const metered = { calls: 0, tokens: 0 };
  const ok = await completeText(
    { system: 'rules', user: 'data', meter: metered },
    {
      async chat() {
        return {
          choices: [{ message: { content: [{ type: 'text', text: '{"summary":"ok"}' }] } }],
          usage: { input_tokens: 12, output_tokens: 24 },
        };
      },
    },
  );
  assert.equal(ok.ok, true);
  assert.equal(metered.calls, 1);
  assert.equal(metered.tokens, 36);
  noteModelResult(null, ok);
  assert.equal(metered.calls, 1);
});

test('usage past the model-call cap does not change the run', async () => {
  const store = createMemoryStore({ now: () => STARTED });
  const run = await store.createRun(runInput());
  const updated = await commitRunBudget(
    store,
    run.runId,
    { calls: RUN_MAX_MODEL_CALLS + 5, tokens: 100 },
    STARTED,
  );
  assert.equal(updated.status, 'planning');
  assert.equal(updated.budget.usedModelCalls, RUN_MAX_MODEL_CALLS + 5);
  assert.equal(updated.budget.usedTokens, 100);
  assert.equal(updated.budget.elapsedMs, 0);
  assert.equal(isWithinRunBudget(updated.budget), false);
  assert.equal(Object.hasOwn(updated.budget, 'criticalPath'), false);
  assert.equal(Object.hasOwn(updated, 'eta'), false);
  assert.equal(await commitRunBudget(store, run.runId, { calls: 0, tokens: 0 }, STARTED), null);

  const later = STARTED + 5 * 60 * 1000;
  const moved = applyRunBudget(updated.budget, { now: later, startedAt: run.createdAt });
  assert.equal(moved.elapsedMs, 5 * 60 * 1000);
  assert.equal(moved.usedModelCalls, updated.budget.usedModelCalls);
  assert.equal(moved.usedSteps, 0);
});

test('applyRunBudget keeps chaos counters and does not invent them', () => {
  const budget = initialRunBudget(STARTED);
  const plain = applyRunBudget(budget, { steps: 1, now: STARTED });
  assert.equal(Object.hasOwn(plain, 'chaos'), false);
  assert.deepEqual(readRunBudget(budget, STARTED).chaos, {
    injected: 0,
    healed: 0,
    duplicateWrites: 0,
  });
  const withChaos = {
    ...budget,
    chaos: { injected: 2, healed: 1, duplicateWrites: 0 },
  };
  const next = applyRunBudget(withChaos, { steps: 1, now: STARTED + 1000 });
  assert.equal(next.usedSteps, 1);
  assert.equal(next.elapsedMs, 1000);
  assert.deepEqual(next.chaos, { injected: 2, healed: 1, duplicateWrites: 0 });
  assert.equal(Object.keys(next).at(-1), 'chaos');
  assert.equal(Object.hasOwn(next, 'effects'), false);
  assert.deepEqual(readRunBudget(next, STARTED).chaos, next.chaos);
});

test('applyRunBudget keeps a flushed dedupe tally and does not invent one', () => {
  const budget = initialRunBudget(STARTED);
  const plain = applyRunBudget(budget, { steps: 1, now: STARTED });
  assert.equal(Object.hasOwn(plain, 'effects'), false);
  const withEffects = {
    ...budget,
    chaos: { injected: 1, healed: 1, duplicateWrites: 0 },
    effects: { deduped: 2 },
  };
  const next = applyRunBudget(withEffects, { steps: 1, now: STARTED + 1000 });
  assert.deepEqual(next.effects, { deduped: 2 });
  assert.equal(Object.keys(next).at(-1), 'effects');
  assert.deepEqual(next.chaos, withEffects.chaos);
  // A broken tally is dropped rather than copied onto the next write.
  const broken = applyRunBudget({ ...budget, effects: { deduped: 1, applied: 4 } }, { now: STARTED });
  assert.equal(Object.hasOwn(broken, 'effects'), false);
});

test('a budget missing a counter is rejected', async () => {
  const store = createMemoryStore({ now: () => STARTED });
  const run = await store.createRun(runInput());
  await assert.rejects(
    store.updateRun(run.runId, { budget: { maxSteps: 8 } }),
    { name: 'StoreValidationError' },
  );
  await assert.rejects(
    store.updateRun(run.runId, {
      budget: { ...run.budget, chaos: { injected: 1 } },
    }),
    { name: 'StoreValidationError' },
  );
  const stored = await store.updateRun(run.runId, {
    budget: {
      ...run.budget,
      chaos: { injected: 1, healed: 1, duplicateWrites: 0 },
    },
  });
  assert.deepEqual(stored.budget.chaos, { injected: 1, healed: 1, duplicateWrites: 0 });
  const kept = await store.updateRun(run.runId, {
    budget: applyRunBudget(stored.budget, { steps: 1, now: STARTED }),
  });
  assert.equal(kept.budget.usedSteps, 1);
  assert.deepEqual(kept.budget.chaos, stored.budget.chaos);
});
