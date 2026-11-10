import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

// Regression: route`${path}` with a whole prebuilt path makes Forge throw
// "Disallowing path manipulation attempt" at runtime (live on the demo site).
function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : files(full);
    return full.endsWith('.js') ? [full] : [];
  });
}

test('no requestJira call wraps a whole prebuilt path in route``', () => {
  const offenders = files(new URL('..', import.meta.url).pathname).filter((file) =>
    /requestJira\(\s*route`\$\{[^}]+\}`/.test(readFileSync(file, 'utf8')),
  );
  assert.deepEqual(offenders, []);
});
