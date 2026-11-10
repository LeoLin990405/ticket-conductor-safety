import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPacksSource } from '../../../scripts/gen-skill-packs.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAllSkills } from '../library.js';

test('packs.generated.js matches skills/*.md (run scripts/gen-skill-packs.mjs)', () => {
  const file = fileURLToPath(new URL('../packs.generated.js', import.meta.url));
  assert.equal(readFileSync(file, 'utf8'), buildPacksSource());
});

test('loader falls back to embedded packs when the default skills dir is missing', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'skills-')), 'nope');
  process.env.CONDUCTOR_SKILLS_DIR = missing;
  try {
    const names = loadAllSkills().map((p) => p.name);
    assert.ok(names.includes('risk-review'));
    assert.ok(names.includes('check-deps'));
    assert.deepEqual(loadAllSkills(join(missing, 'x')), []);
  } finally {
    delete process.env.CONDUCTOR_SKILLS_DIR;
  }
});
