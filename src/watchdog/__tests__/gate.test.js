import test from 'node:test';
import assert from 'node:assert/strict';
import { GATE_KEY, SCAN_EVERY_MS, markActive, onScanTick, shouldScan } from '../gate.js';

function fakeKvs() {
  const map = new Map();
  let reads = 0;
  return {
    map,
    get reads() { return reads; },
    async get(key) { reads += 1; return map.get(key) ?? null; },
    async set(key, value) { map.set(key, value); },
  };
}

test('off-tick pass reads nothing', async () => {
  const kvs = fakeKvs();
  const result = await shouldScan({ now: SCAN_EVERY_MS * 10 + 6 * 60 * 1000, kvs });
  assert.deepEqual(result, { scan: false, reason: 'off-tick' });
  assert.equal(kvs.reads, 0);
});

test('idle gate skips after one read; markActive opens it for two hours', async () => {
  const kvs = fakeKvs();
  const now = SCAN_EVERY_MS * 100;
  assert.equal((await shouldScan({ now, kvs })).reason, 'idle');
  assert.equal(kvs.reads, 1);
  await markActive({ now, kvs });
  assert.ok(kvs.map.get(GATE_KEY).activeUntil > now);
  assert.equal((await shouldScan({ now: now + SCAN_EVERY_MS, kvs })).scan, true);
  assert.equal((await shouldScan({ now: now + 3 * 60 * 60 * 1000, kvs })).reason, 'idle');
});

test('one tick in three scans', () => {
  const ticks = [0, 5, 10, 15, 20, 25].map((m) => onScanTick(m * 60 * 1000));
  assert.deepEqual(ticks, [true, false, false, true, false, false]);
});
