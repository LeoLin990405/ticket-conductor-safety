import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ENTITY_INTEGER_MAX,
  epochMsFitsEntityInteger,
} from './timestamps.js';

test('epoch milliseconds do not fit a Custom Entity integer attribute', () => {
  // 2026-11-01 is far past 2_147_483_647 ms (which is only ~24.8 days after the Unix epoch).
  const now = Date.parse('2026-11-01T00:00:00.000Z');
  assert.ok(now > ENTITY_INTEGER_MAX);
  assert.equal(epochMsFitsEntityInteger(now), false);
  assert.equal(epochMsFitsEntityInteger(0), true);
  assert.equal(epochMsFitsEntityInteger(ENTITY_INTEGER_MAX), true);
  assert.equal(epochMsFitsEntityInteger(ENTITY_INTEGER_MAX + 1), false);
});

test('spike manifest encodes the WP0 decisions the linter must accept', () => {
  const manifest = readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8');

  assert.match(manifest, /^ {2}rovo:skill:/m);
  assert.match(manifest, /timeoutSeconds: 900/);
  assert.match(manifest, /model:\n {8}- claude/);
  assert.match(manifest, /api\.anthropic\.com/);
  // Indexed timestamps are float, not integer. The integer attribute exists
  // only so the live probe can show that epoch ms is rejected.
  assert.match(manifest, /createdAt:\n\s+type: float/);
  assert.match(manifest, /epochMsInt:\n\s+type: integer/);
  assert.doesNotMatch(manifest, /00000000-0000-4000-8000-0000000000a1/);
});
