import test from 'node:test';
import assert from 'node:assert/strict';
import { lessonHow, lessonOutcome, outcomeClause } from '../lessonText.js';

test('lesson outcome follows the source', () => {
  assert.equal(lessonOutcome({ kind: 'summarize' }), 'succeeded');
  assert.equal(lessonOutcome({ kind: 'watchdog-retry' }), 'retried');
  assert.equal(lessonOutcome({ kind: 'step-failed' }), 'failed');
  assert.equal(lessonOutcome({ kind: 'step-blocked' }), 'blocked');
  assert.equal(lessonOutcome({ kind: 'summarize', outcome: 'failed' }), 'failed');
});

test('a lesson from a successful run never says it blocked', () => {
  const how = lessonHow('broaden the search', 'prepend', 'succeeded');
  assert.doesNotMatch(how, /blocked|failed/);
  assert.match(how, /^last run succeeded and noted: broaden the search/);
  assert.match(outcomeClause('x', 'retried'), /watchdog retry/);
  assert.match(outcomeClause('x', 'failed'), /^last run failed on x/);
  assert.match(outcomeClause('x', 'blocked'), /^last run blocked on x/);
});
