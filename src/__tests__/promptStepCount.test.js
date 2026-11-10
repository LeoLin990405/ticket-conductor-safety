import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const playbook = readFileSync(new URL('../../prompts/conductor-playbook/SKILL.md', import.meta.url), 'utf8');
const router = readFileSync(new URL('../../prompts/router.md', import.meta.url), 'utf8');

test('prompts allow 1 to 8 steps and no longer require three', () => {
  for (const text of [playbook, router]) {
    assert.doesNotMatch(text, /three to eight|3 to 8|Fewer than 3/);
  }
  assert.match(playbook, /1 to 8 steps/);
});

test('prompts do not treat plan-and-run as permission to dispatch', () => {
  assert.match(playbook, /is not a confirmation/);
  assert.match(router, /is not a confirmation/);
  assert.match(router, /confirmToken/);
  assert.doesNotMatch(router, /that is the agreement/);
  assert.doesNotMatch(playbook, /that is the agreement/);
});
