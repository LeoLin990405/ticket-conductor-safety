import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushWithRetry, isTransientQueuePushError, QUEUE_PUSH_BACKOFF_MS } from '../queuePushRetry.js';

const bad = () => Object.assign(new Error('400 Bad Request'), { name: 'InternalServerError' });

test('classifies post-deploy 400 and 5xx as transient', () => {
  assert.equal(isTransientQueuePushError(bad()), true);
  assert.equal(isTransientQueuePushError(new Error('503 Service Unavailable')), true);
  assert.equal(isTransientQueuePushError(new TypeError('bare object')), false);
});

test('retries with backoff then succeeds', async () => {
  let n = 0; const sleeps = [];
  const out = await pushWithRetry(async () => { n += 1; if (n < 3) throw bad(); return 'ok'; },
    { sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(out, 'ok');
  assert.deepEqual(sleeps, QUEUE_PUSH_BACKOFF_MS.slice(0, 2));
});

test('bounded, and non-transient errors are not retried', async () => {
  let n = 0;
  await assert.rejects(pushWithRetry(async () => { n += 1; throw bad(); }, { sleep: async () => {} }));
  assert.equal(n, QUEUE_PUSH_BACKOFF_MS.length + 1);
  n = 0;
  await assert.rejects(pushWithRetry(async () => { n += 1; throw new TypeError('x'); }, { sleep: async () => {} }));
  assert.equal(n, 1);
});
