import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createForgeBackend, isTransientKvs422, TRANSIENT_422_BACKOFF_MS } from '../forgeAdapter.js';
import { buildEntitySchemaSource } from '../../../scripts/gen-entity-schema.mjs';

function err422() {
  return Object.assign(new Error('Unprocessable'), { code: 'UNPROCESSABLE_ENTITY', context: {} });
}
function fakeSdk(failures) {
  const calls = { set: 0, transact: 0 };
  const sdk = {
    kvs: {
      entity: () => ({
        set: async () => { calls.set += 1; if (calls.set <= failures) throw err422(); },
        get: async () => ({ value: { status: 'queued' } }),
      }),
      transact: () => ({
        set() { return this; },
        execute: async () => { calls.transact += 1; if (calls.transact <= failures) throw err422(); },
      }),
    },
    Filter: class { and() { return this; } },
    FilterConditions: { equalTo: (v) => v },
  };
  return { sdk, calls };
}

test('generated entity schema matches manifest.yml', () => {
  assert.equal(readFileSync(new URL('../entitySchema.generated.js', import.meta.url), 'utf8'), buildEntitySchemaSource());
});

test('422 is transient only when every attribute is declared', () => {
  assert.equal(isTransientKvs422(err422(), 'run', { status: 'x' }), true);
  assert.equal(isTransientKvs422(err422(), 'run', { notDeclared: 1 }), false);
  assert.equal(isTransientKvs422(new Error('boom'), 'run', { status: 'x' }), false);
  assert.equal(isTransientKvs422({ code: 'CONDITIONAL_CHECK_FAILED', status: 422 }, 'run', {}), false);
});

test('set retries a transient 422 with backoff, then succeeds', async () => {
  const { sdk, calls } = fakeSdk(2);
  const sleeps = [];
  const backend = createForgeBackend(sdk, { sleep: async (ms) => { sleeps.push(ms); } });
  await backend.set('run', 'r1', { status: 'queued' });
  assert.equal(calls.set, 3);
  assert.deepEqual(sleeps, TRANSIENT_422_BACKOFF_MS.slice(0, 2));
});

test('retry is bounded', async () => {
  const { sdk, calls } = fakeSdk(99);
  const backend = createForgeBackend(sdk, { sleep: async () => {} });
  await assert.rejects(backend.set('run', 'r1', { status: 'queued' }), /Unprocessable/);
  assert.equal(calls.set, TRANSIENT_422_BACKOFF_MS.length + 1);
});

test('undeclared attribute 422 is not retried', async () => {
  const { sdk, calls } = fakeSdk(99);
  const backend = createForgeBackend(sdk, { sleep: async () => {} });
  await assert.rejects(backend.set('run', 'r1', { bogusField: 1 }));
  assert.equal(calls.set, 1);
});

test('updateIfMatch retries a transient 422 on the transaction', async () => {
  const { sdk, calls } = fakeSdk(1);
  const backend = createForgeBackend(sdk, { sleep: async () => {} });
  assert.equal(await backend.updateIfMatch('run', 'r1', { status: 'running' }, 'status', 'queued'), true);
  assert.equal(calls.transact, 2);
});
