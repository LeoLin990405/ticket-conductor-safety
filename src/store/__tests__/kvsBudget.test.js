import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBackend } from '../memoryAdapter.js';
import { createStoreFromBackend, EVENT_TEXT_MAX, MEMORY_LIST_CAP, trimEventDetail } from '../storeCore.js';

function countingStore() {
  const backend = createMemoryBackend();
  const counts = { query: 0 };
  const wrapped = {
    ...backend,
    async query(...args) { counts.query += 1; return backend.query(...args); },
  };
  return { store: createStoreFromBackend(wrapped), counts };
}

test('memory list is read once per minute and capped', async () => {
  const { store, counts } = countingStore();
  for (let i = 0; i < MEMORY_LIST_CAP + 5; i += 1) {
    await store.addMemory({ projectKey: 'PAY', memType: 'fact', text: `fact ${i}`, sourceIssue: 'PAY-1' });
  }
  const first = await store.listMemoriesByProject('PAY');
  const again = await store.listMemoriesByProject('PAY');
  assert.equal(first.length, MEMORY_LIST_CAP);
  assert.equal(again.length, MEMORY_LIST_CAP);
  assert.equal(counts.query, 1);
  await store.listMemoriesByProject('PAY', { fresh: true });
  assert.equal(counts.query, 2);
  await store.addMemory({ projectKey: 'PAY', memType: 'fact', text: 'new', sourceIssue: 'PAY-2' });
  await store.listMemoriesByProject('PAY');
  assert.equal(counts.query, 3, 'a write clears the cache');
});

test('event seq is read once per run, then kept in process', async () => {
  const { store, counts } = countingStore();
  for (let i = 0; i < 4; i += 1) {
    await store.appendEvent({ runId: 'r1', kind: 'plan.created', detail: { i } });
  }
  assert.equal(counts.query, 1);
  const events = await store.listEventsByRun('r1');
  assert.deepEqual(events.map((e) => e.seq), [0, 1, 2, 3]);
});

test('a second writer on the same run never produces a duplicate seq', async () => {
  const backend = createMemoryBackend();
  const a = createStoreFromBackend(backend);
  const b = createStoreFromBackend(backend);
  await a.appendEvent({ runId: 'r1', kind: 'plan.created' });
  await b.appendEvent({ runId: 'r1', kind: 'plan.created' });
  await a.appendEvent({ runId: 'r1', kind: 'plan.created' });
  const seqs = (await a.listEventsByRun('r1')).map((e) => e.seq);
  assert.deepEqual(seqs, [0, 1, 2]);
});

test('event payload strings are clipped', () => {
  const out = trimEventDetail({ why: 'x'.repeat(5000), nested: { list: Array(50).fill('y') } });
  assert.equal(out.why.length, EVENT_TEXT_MAX);
  assert.equal(out.nested.list.length, 20);
});
