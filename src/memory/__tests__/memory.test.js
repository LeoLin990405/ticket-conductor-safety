/**
 * Unit tests for WP6 run memory.
 *
 * WP2 is not on this branch. Every test injects a small fake effects queue that
 * implements the documented WP2 contract: `enqueueEffect` computes a
 * deterministic request key and writes the effect through WP1's
 * `putEffectIfAbsent`, so duplicate enqueues produce exactly one effect.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  createMemoryStore,
  resetStore,
  setStore,
} from '../../store/index.js';
import {
  MEMORY_COMMENT_DISCRIMINATOR,
  MEMORY_COMMENT_HEADER,
  createMemory,
  recall,
  record,
  resetMemory,
  setMemoryEffects,
  writeBack,
} from '../index.js';
import { buildMemoryComment } from '../comment.js';
import { normalizeText, stem, tokenize } from '../scoring.js';

/**
 * Deterministic clock/id generator for the in-memory store.
 *
 * @returns {{
 *   now: () => number,
 *   newId: () => string,
 *   advance: (ms: number) => void,
 *   current: number
 * }}
 */
function makeEnv() {
  let now = Date.UTC(2026, 10, 1, 12, 0, 0);
  let id = 0;
  return {
    now: () => now,
    newId: () => {
      id += 1;
      return `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
    },
    advance(ms) {
      now += ms;
    },
    get current() {
      return now;
    },
  };
}

/**
 * Minimal stand-in for the WP2 `src/effects/index.js` module.
 *
 * @param {import('../../store/types.js').Store} store
 * @returns {{enqueueEffect: Function, requestKeyFor: Function, calls: object[]}}
 */
function createFakeEffects(store) {
  const calls = [];

  function requestKeyFor({ runId, stepId, kind, discriminator }) {
    return createHash('sha256')
      .update([runId ?? '', stepId ?? '', kind, discriminator].join('|'))
      .digest('hex');
  }

  async function enqueueEffect(input) {
    const requestKey = requestKeyFor(input);
    const { created } = await store.putEffectIfAbsent({
      requestKey,
      runId: input.runId,
      stepId: input.stepId ?? undefined,
      kind: input.kind,
      payload: input.payload,
    });
    calls.push({ requestKey, created });
    return { requestKey, created };
  }

  return { enqueueEffect, requestKeyFor, calls };
}

/**
 * @param {{goal?: string, projectKey?: string, epicKey?: string}} [overrides]
 */
async function setup(overrides = {}) {
  const env = makeEnv();
  const store = createMemoryStore({ now: env.now, newId: env.newId });
  const effects = createFakeEffects(store);
  const deps = { store, effects, now: env.now };
  const run = await store.createRun({
    epicKey: overrides.epicKey ?? 'PAY-1',
    projectKey: overrides.projectKey ?? 'PAY',
    goal: overrides.goal ?? 'Ship payment refunds',
    createdBy: 'account-1',
  });
  return { env, store, effects, deps, run };
}

const REFUND_DECISION = {
  text:
    'Refunds are idempotent on the payment id. A duplicate webhook returns ' +
    'the original ledger line and does not create a second one.',
  type: 'decision',
};

test('writeBack stores one memory per decision and enqueues an Epic comment', async () => {
  const { store, effects, deps, run } = await setup();

  const result = await writeBack(
    run.runId,
    { summary: 'Shipped refunds.', decisions: [REFUND_DECISION] },
    deps,
  );

  assert.equal(result.memIds.length, 1);
  const memories = await store.listMemoriesByProject('PAY');
  assert.equal(memories.length, 1);
  const [memory] = memories;

  assert.equal(memory.memId, result.memIds[0]);
  assert.equal(memory.projectKey, 'PAY');
  assert.equal(memory.scope, 'project');
  assert.equal(memory.memType, 'decision');
  assert.equal(memory.text, REFUND_DECISION.text);
  assert.equal(memory.sourceIssue, run.epicKey);
  assert.equal(memory.runId, run.runId);
  assert.equal(memory.validUntil, 0);
  assert.equal(memory.supersededBy, undefined);

  assert.equal(effects.calls.length, 1);
  const effect = await store.getEffect(effects.calls[0].requestKey);
  assert.equal(effect.kind, 'comment');
  assert.equal(effect.status, 'pending');
  assert.equal(effect.payload.issueKey, run.epicKey);
  assert.ok(effect.payload.bodyText.startsWith(MEMORY_COMMENT_HEADER));
  assert.match(effect.payload.bodyText, /Shipped refunds\./);
  assert.match(effect.payload.bodyText, /Refunds are idempotent/);

  const heading = effect.payload.bodyAdf.content[0];
  assert.equal(heading.type, 'heading');
  assert.equal(heading.content[0].text, MEMORY_COMMENT_HEADER);
});

test('writeBack is idempotent for the same run: one memory and one comment effect', async () => {
  const { store, effects, deps, run } = await setup();

  const first = await writeBack(
    run.runId,
    { summary: 'Shipped refunds.', decisions: [REFUND_DECISION] },
    deps,
  );
  const second = await writeBack(
    run.runId,
    { summary: 'Shipped refunds.', decisions: [REFUND_DECISION] },
    deps,
  );

  assert.deepEqual(second.memIds, first.memIds);
  assert.equal((await store.listMemoriesByProject('PAY')).length, 1);
  assert.equal((await store.listEffectsByStatus('pending')).length, 1);
  assert.equal(effects.calls.length, 2);
  assert.equal(effects.calls[0].created, true);
  assert.equal(effects.calls[1].created, false);
  assert.equal(effects.calls[0].requestKey, effects.calls[1].requestKey);
  assert.equal(
    effects.calls[0].requestKey,
    effects.requestKeyFor({
      runId: run.runId,
      stepId: null,
      kind: 'comment',
      discriminator: MEMORY_COMMENT_DISCRIMINATOR,
    }),
  );
});

test('recall returns a decision from run 1 for a related goal in run 2', async () => {
  const { store, deps, run, env } = await setup();

  await writeBack(
    run.runId,
    { summary: 'Shipped refunds.', decisions: [REFUND_DECISION] },
    deps,
  );
  await store.addMemory({
    projectKey: 'PAY',
    memType: 'lesson',
    text: 'Run the linter before opening a pull request.',
  });
  await store.addMemory({
    projectKey: 'OTHER',
    memType: 'decision',
    text: 'Refunds are idempotent on the payment id.',
  });
  env.advance(1000);

  const relatedGoal =
    'Plan how to reconcile the refund ledger with the provider. ' +
    'Keep one refund per payment id.';
  const recalled = await recall(
    { projectKey: 'PAY', query: relatedGoal },
    deps,
  );

  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].text, REFUND_DECISION.text);
  assert.equal(recalled[0].memType, 'decision');
});

test('recall ranks stronger overlap first and honours k', async () => {
  const { store, deps, env } = await setup();

  await store.addMemory({
    projectKey: 'PAY',
    memType: 'fact',
    text: 'Ledger rows are immutable.',
  });
  env.advance(10);
  await store.addMemory({
    projectKey: 'PAY',
    memType: 'decision',
    text: 'Reconcile the refund ledger against the provider statement nightly.',
  });
  env.advance(10);
  await store.addMemory({
    projectKey: 'PAY',
    memType: 'lesson',
    text: 'Refund ledger reconciliation needs the provider statement.',
  });

  const query = 'refund ledger provider statement';
  const all = await recall({ projectKey: 'PAY', query, k: 5 }, deps);
  assert.equal(all.length, 3);
  assert.ok(
    all[0].text.includes('Reconcile') ||
      all[0].text.includes('reconciliation'),
    'the two full matches should outrank the one-term fact',
  );

  const one = await recall({ projectKey: 'PAY', query, k: 1 }, deps);
  assert.equal(one.length, 1);
  assert.equal(one[0].memId, all[0].memId);

  const none = await recall({ projectKey: 'PAY', query, k: 0 }, deps);
  assert.deepEqual(none, []);
});

test('recall skips superseded and expired rows', async () => {
  const { store, deps, env } = await setup();

  const old = await store.addMemory({
    projectKey: 'PAY',
    memType: 'decision',
    text: 'Refund ledger uses a lock.',
  });
  const replacement = await store.addMemory({
    projectKey: 'PAY',
    memType: 'decision',
    text: 'Refund ledger uses an idempotency key.',
  });
  await store.supersedeMemory(old.memId, replacement.memId);
  const expired = await store.addMemory({
    projectKey: 'PAY',
    memType: 'lesson',
    text: 'Refund ledger is rebuilt nightly.',
    validUntil: env.current - 1,
  });
  const forever = await store.addMemory({
    projectKey: 'PAY',
    memType: 'fact',
    text: 'Refund ledger keeps one row per refund.',
    validUntil: 0,
  });
  env.advance(10);

  const recalled = await recall(
    { projectKey: 'PAY', query: 'refund ledger' },
    deps,
  );
  const ids = recalled.map((memory) => memory.memId);

  assert.ok(!ids.includes(old.memId), 'superseded row is excluded');
  assert.ok(!ids.includes(expired.memId), 'expired row is excluded');
  assert.ok(ids.includes(replacement.memId));
  assert.ok(ids.includes(forever.memId));
});

test('record stores an explicit lesson with memType and sourceIssue', async () => {
  const { store, deps } = await setup();

  const result = await record(
    {
      projectKey: 'PAY',
      epicKey: 'PAY-2',
      text:
        'Reconcile against the provider statement before posting a ledger ' +
        'correction.',
      type: 'lesson',
    },
    deps,
  );

  assert.equal(typeof result.memId, 'string');
  const memories = await store.listMemoriesByProject('PAY');
  assert.equal(memories.length, 1);
  const [memory] = memories;

  assert.equal(memory.memId, result.memId);
  assert.equal(memory.memType, 'lesson');
  assert.equal(memory.scope, 'project');
  assert.equal(memory.sourceIssue, 'PAY-2');
  assert.equal(memory.validUntil, 0);
  assert.equal(memory.supersededBy, undefined);

  const recalled = await recall(
    { projectKey: 'PAY', query: 'ledger correction provider statement' },
    deps,
  );
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].memId, result.memId);
});

test('writeBack accepts a summary without decisions and rejects empty content', async () => {
  const { store, deps, run } = await setup();

  const result = await writeBack(
    run.runId,
    { summary: 'Run finished with no decisions.' },
    deps,
  );
  assert.deepEqual(result.memIds, []);
  assert.equal((await store.listMemoriesByProject('PAY')).length, 0);
  assert.equal((await store.listEffectsByStatus('pending')).length, 1);

  await assert.rejects(
    () => writeBack(run.runId, { summary: '   ', decisions: [] }, deps),
    /non-empty summary or at least one decision/,
  );
  assert.equal((await store.listEffectsByStatus('pending')).length, 1);
});

test('writeBack and record validate ids, categories, and decisions', async () => {
  const { deps, run } = await setup();

  await assert.rejects(
    () => writeBack('missing-run', { summary: 'x' }, deps),
    /not found/,
  );
  await assert.rejects(
    () =>
      writeBack(
        run.runId,
        { decisions: [{ text: 'x', type: 'bogus' }] },
        deps,
      ),
    /type must be one of/,
  );
  await assert.rejects(
    () => writeBack(run.runId, { decisions: 'not-an-array' }, deps),
    /must be an array/,
  );
  await assert.rejects(
    () => writeBack(run.runId, { decisions: [{ type: 'decision' }] }, deps),
    /text must be a string/,
  );
  await assert.rejects(
    () =>
      record(
        { projectKey: 'PAY', epicKey: 'PAY-1', text: 'x', type: 'bogus' },
        deps,
      ),
    /type must be one of/,
  );
  await assert.rejects(
    () => record({ projectKey: 'PAY', epicKey: '', text: 'x' }, deps),
    /epicKey must not be empty/,
  );
  await assert.rejects(
    () => recall({ projectKey: 'PAY', query: 'x', k: -1 }, deps),
    /non-negative integer/,
  );
});

test('recall accepts object queries and filters stopword-only queries', async () => {
  const { store, deps } = await setup();

  await store.addMemory({
    projectKey: 'PAY',
    memType: 'decision',
    text: 'Refund ledger rows are immutable and keyed by payment id.',
  });

  const recalled = await recall(
    {
      projectKey: 'PAY',
      query: { goal: 'reconcile refund ledger', labels: ['payments'] },
    },
    deps,
  );
  assert.equal(recalled.length, 1);

  const empty = await recall(
    { projectKey: 'PAY', query: { goal: 'the and for' } },
    deps,
  );
  assert.deepEqual(empty, []);
});

test('tokenizer normalises camelCase, plurals, and stopwords', () => {
  assert.equal(normalizeText('paymentId'), 'payment id');
  assert.equal(stem('refunds'), 'refund');
  assert.equal(stem('processing'), 'process');
  assert.equal(stem('shipped'), 'ship');
  assert.equal(stem('created'), 'create');
  assert.deepEqual(tokenize('The refunds are paymentId'), [
    'refund',
    'payment',
    'id',
  ]);
});

test('buildMemoryComment starts with the header and includes typed decisions', () => {
  const comment = buildMemoryComment({
    summary: 'Done.',
    decisions: [{ text: 'Use locks.', type: 'lesson' }],
  });

  assert.ok(comment.bodyText.startsWith('[Conductor memory]'));
  assert.match(comment.bodyText, /Done\./);
  assert.match(comment.bodyText, /\[lesson\] Use locks\./);
  assert.equal(comment.bodyAdf.type, 'doc');
  assert.equal(comment.bodyAdf.content[0].content[0].text, '[Conductor memory]');
  assert.equal(
    comment.bodyAdf.content[2].content[0].content[0].content[0].text,
    '[lesson] Use locks.',
  );
});

test('createMemory returns a service with the three public operations', async () => {
  const { store, effects, run } = await setup();
  const memory = createMemory({ store, effects });

  assert.equal(typeof memory.writeBack, 'function');
  assert.equal(typeof memory.recall, 'function');
  assert.equal(typeof memory.record, 'function');

  const written = await memory.writeBack(run.runId, {
    summary: 'Service form.',
    decisions: [REFUND_DECISION],
  });
  assert.equal(written.memIds.length, 1);

  const recorded = await memory.record({
    projectKey: 'PAY',
    epicKey: run.epicKey,
    text: 'Service record works.',
    type: 'fact',
  });
  assert.equal(typeof recorded.memId, 'string');

  const recalled = await memory.recall({
    projectKey: 'PAY',
    query: 'refund idempotent payment',
  });
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].text, REFUND_DECISION.text);
});

test('named exports use setStore and setMemoryEffects', async () => {
  const env = makeEnv();
  const store = createMemoryStore({ now: env.now, newId: env.newId });
  const effects = createFakeEffects(store);
  setStore(store);
  setMemoryEffects(effects);

  try {
    const run = await store.createRun({
      epicKey: 'PAY-9',
      projectKey: 'PAY',
      goal: 'Injected dependencies',
      createdBy: 'account-1',
    });

    const written = await writeBack(run.runId, {
      decisions: [{ text: 'Injected store works.', type: 'fact' }],
    });
    assert.equal(written.memIds.length, 1);
    assert.equal((await store.listEffectsByStatus('pending')).length, 1);

    const recorded = await record({
      projectKey: 'PAY',
      epicKey: run.epicKey,
      text: 'Injected record works.',
      type: 'fact',
    });
    assert.equal(typeof recorded.memId, 'string');
  } finally {
    resetMemory();
    resetStore();
  }
});

test('a bare store is accepted as the optional dependency argument', async () => {
  const { store, run } = await setup();

  const recorded = await record(
    {
      projectKey: 'PAY',
      epicKey: run.epicKey,
      text: 'Bare store works.',
      type: 'fact',
    },
    store,
  );
  assert.equal(typeof recorded.memId, 'string');
});
