/**
 * Comment batching is a pure fold of one step's effect list.
 *
 * These tests do not boot the simulator and do not call Jira. They pin the
 * rules the step worker and replay both rely on: one comment stays the same
 * object, two comments for one issue become one effect, and a payload that
 * would not fit in the effect field is left as separate comments.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_VALUE_BYTES } from '../../store/types.js';
import { coalesceCommentEffects } from '../commentBatch.js';
import { requestKeyFor } from '../requestKey.js';

/**
 * @param {string} text
 * @returns {object}
 */
function paragraphDoc(text) {
  return {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text }] },
    ],
  };
}

test('one comment is returned unchanged so its request key stays put', () => {
  const effect = {
    kind: 'comment',
    discriminator: 'research-comment',
    payload: { issueKey: 'PAY-101', bodyText: 'Research notes' },
  };
  const step = { stepId: 'step-1', childIssueKey: 'PAY-101' };
  const coalesced = coalesceCommentEffects([effect], step);
  assert.equal(coalesced.length, 1);
  assert.equal(coalesced[0], effect);
  assert.equal(coalesced[0].payload.batchedFrom, undefined);
  const before = requestKeyFor({
    runId: 'run-1',
    stepId: 'step-1',
    kind: 'comment',
    discriminator: 'research-comment',
  });
  const after = requestKeyFor({
    runId: 'run-1',
    stepId: 'step-1',
    kind: 'comment',
    discriminator: coalesced[0].discriminator,
  });
  assert.equal(after, before);
});

test('two comments for one child become one effect and a transition stays', () => {
  const step = { stepId: 'step-1', childIssueKey: 'PAY-101' };
  const coalesced = coalesceCommentEffects([
    {
      kind: 'comment',
      discriminator: 'worker-output',
      payload: {
        issueKey: 'PAY-101',
        bodyText: 'WORKER-OUTPUT the refund notes',
        bodyAdf: paragraphDoc('WORKER-OUTPUT the refund notes'),
      },
    },
    {
      kind: 'transition',
      discriminator: 'transition:Done',
      payload: { issueKey: 'PAY-101', toStatusName: 'Done' },
    },
    {
      kind: 'comment',
      discriminator: 'status-note',
      payload: {
        issueKey: 'PAY-101',
        bodyText: 'STATUS-NOTE the step finished',
        bodyAdf: paragraphDoc('STATUS-NOTE the step finished'),
      },
    },
  ], step);

  assert.equal(coalesced.length, 2);
  assert.equal(coalesced[0].kind, 'comment');
  // Sorted names, so the key does not depend on which part was listed first.
  assert.equal(coalesced[0].discriminator, 'batch:status-note+worker-output');
  assert.equal(
    coalesced[0].payload.bodyText,
    'WORKER-OUTPUT the refund notes\n\nSTATUS-NOTE the step finished',
  );
  assert.deepEqual(coalesced[0].payload.batchedFrom, ['worker-output', 'status-note']);
  assert.equal(coalesced[0].payload.issueKey, 'PAY-101');
  const posted = JSON.stringify(coalesced[0].payload.bodyAdf);
  assert.match(posted, /WORKER-OUTPUT the refund notes/);
  assert.match(posted, /STATUS-NOTE the step finished/);
  assert.equal(coalesced[1].kind, 'transition');
  assert.equal(coalesced[1].discriminator, 'transition:Done');
});

test('comments for different issues are not merged', () => {
  const child = {
    kind: 'comment',
    discriminator: 'worker-output',
    payload: { issueKey: 'PAY-101', bodyText: 'on the child' },
  };
  const epic = {
    kind: 'comment',
    discriminator: 'wave-report:1',
    payload: { issueKey: 'PAY-1', bodyText: '[Conductor wave]\nWave 1 finished.' },
  };
  const coalesced = coalesceCommentEffects([child, epic], {
    stepId: 'step-1',
    childIssueKey: 'PAY-101',
  });
  assert.equal(coalesced.length, 2);
  assert.equal(coalesced[0], child);
  assert.equal(coalesced[1], epic);
});

test('a deferred comment and a keyed comment for the same child merge', () => {
  const step = { stepId: 'step-1', childIssueKey: 'PAY-101' };
  const coalesced = coalesceCommentEffects([
    {
      kind: 'comment',
      discriminator: 'worker-output',
      payload: { childOfStepId: 'step-1', bodyText: 'deferred output' },
    },
    {
      kind: 'comment',
      discriminator: 'status-note',
      payload: { issueKey: 'PAY-101', bodyText: 'keyed note' },
    },
  ], step);
  assert.equal(coalesced.length, 1);
  assert.equal(coalesced[0].payload.issueKey, 'PAY-101');
  assert.equal(coalesced[0].payload.childOfStepId, undefined);
  assert.match(coalesced[0].payload.bodyText, /deferred output/);
  assert.match(coalesced[0].payload.bodyText, /keyed note/);
});

test('deferred comments for different steps stay separate', () => {
  const coalesced = coalesceCommentEffects([
    {
      kind: 'comment',
      discriminator: 'worker-output',
      payload: { childOfStepId: 'step-1', bodyText: 'one' },
    },
    {
      kind: 'comment',
      discriminator: 'status-note',
      payload: { childOfStepId: 'step-2', bodyText: 'two' },
    },
  ], null);
  assert.equal(coalesced.length, 2);
  assert.equal(coalesced[0].discriminator, 'worker-output');
  assert.equal(coalesced[1].discriminator, 'status-note');
});

test('a comment with no discriminator keeps the index it had before the fold', () => {
  const coalesced = coalesceCommentEffects([
    { kind: 'comment', payload: { issueKey: 'PAY-101', bodyText: 'one' } },
    { kind: 'comment', payload: { issueKey: 'PAY-101', bodyText: 'two' } },
    { kind: 'comment', payload: { issueKey: 'PAY-102', bodyText: 'three' } },
  ], { stepId: 'step-1', childIssueKey: 'PAY-101' });
  assert.equal(coalesced.length, 2);
  assert.equal(coalesced[0].discriminator, 'batch:comment:0+comment:1');
  assert.equal(coalesced[1].discriminator, 'comment:2');
  assert.equal(coalesced[1].payload.bodyText, 'three');
});

test('a merged payload over 64 KiB is left as separate comments', () => {
  const chunk = 'x'.repeat(Math.ceil(MAX_VALUE_BYTES / 2) + 1000);
  const coalesced = coalesceCommentEffects([
    {
      kind: 'comment',
      discriminator: 'worker-output',
      payload: { issueKey: 'PAY-101', bodyText: chunk },
    },
    {
      kind: 'comment',
      discriminator: 'status-note',
      payload: { issueKey: 'PAY-101', bodyText: chunk },
    },
  ], { stepId: 'step-1', childIssueKey: 'PAY-101' });
  assert.equal(coalesced.length, 2);
  assert.equal(coalesced[0].discriminator, 'worker-output');
  assert.equal(coalesced[1].discriminator, 'status-note');
  assert.equal(coalesced[0].payload.batchedFrom, undefined);
});

test('the input comment is not mutated', () => {
  const effect = {
    kind: 'comment',
    discriminator: 'worker-output',
    payload: { issueKey: 'PAY-101', bodyText: 'WORKER-OUTPUT' },
  };
  coalesceCommentEffects([
    effect,
    {
      kind: 'comment',
      discriminator: 'status-note',
      payload: { issueKey: 'PAY-101', bodyText: 'STATUS-NOTE' },
    },
  ], { stepId: 'step-1', childIssueKey: 'PAY-101' });
  assert.equal(effect.payload.bodyText, 'WORKER-OUTPUT');
  assert.equal(effect.payload.batchedFrom, undefined);
});

test('a non-array is an empty list', () => {
  assert.deepEqual(coalesceCommentEffects(null), []);
});
