import assert from 'node:assert/strict';
import test from 'node:test';

import { createForgeStore } from '../index.js';
import { createFakeForgeSdk } from './fakeForgeKvs.js';

function makeStore(sdk, start = 1_700_000_000_000.5) {
  let now = start;
  let id = 0;
  return createForgeStore({ sdk, now: () => (now += 1), newId: () => `id-${++id}` });
}

const runInput = { epicKey: 'TC-1', projectKey: 'TC', goal: 'g', createdBy: 'a' };

test('updateRun CAS conditions on the numeric updatedAt it read', async () => {
  const sdk = createFakeForgeSdk();
  const store = makeStore(sdk);
  const run = await store.createRun(runInput);
  await store.updateRun(run.runId, { status: 'running' }, { expectedUpdatedAt: run.updatedAt });
  const tx = sdk.calls.transactions.at(-1).ops[0];
  const cond = tx.options.conditions.items[0];
  assert.equal(cond.field, 'updatedAt');
  assert.equal(typeof cond.value, 'number');
  assert.equal(cond.value, run.updatedAt);
});

test('a stale updatedAt is a ConflictError, so only one concurrent writer wins', async () => {
  const sdk = createFakeForgeSdk();
  const store = makeStore(sdk);
  const run = await store.createRun(runInput);
  const results = await Promise.allSettled([
    store.updateRun(run.runId, { status: 'running' }, { expectedUpdatedAt: run.updatedAt }),
    store.updateRun(run.runId, { status: 'blocked' }, { expectedUpdatedAt: run.updatedAt }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const bad = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].reason.name, 'ConflictError');
});

test('a refused write whose condition held is rethrown with write context', async () => {
  const sdk = createFakeForgeSdk();
  const store = makeStore(sdk);
  const run = await store.createRun(runInput);
  const realTransact = sdk.kvs.transact;
  sdk.kvs.transact = () => {
    const builder = realTransact.call(sdk.kvs);
    builder.execute = async () => {
      const error = new Error('Request cannot be processed due to one or more semantic errors');
      error.code = 'UNPROCESSABLE_ENTITY';
      throw error;
    };
    return builder;
  };
  await assert.rejects(
    store.updateRun(run.runId, { status: 'running' }, { expectedUpdatedAt: run.updatedAt }),
    (error) => error.code === 'UNPROCESSABLE_ENTITY'
      && error.kvsWrite.conditionField === 'updatedAt'
      && error.kvsWrite.entityName === 'run',
  );
});
