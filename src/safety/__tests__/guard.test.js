import assert from 'node:assert/strict';
import test from 'node:test';

import { previewBlastRadius } from '../../blast/preview.js';
import {
  acknowledgementText,
  confirmationToken,
} from '../guard.js';
import { authorizeDispatch, CONFIRM_TTL_MS, issueDispatchGrant, resetConfirmationGrants } from '../grants.js';
import { formatSafetyReport, runSafetyEval } from '../eval.js';
import { runNaiveComparison } from '../naiveAgent.js';

test('a panel grant is single-use and the public card digest is not a token', () => {
  resetConfirmationGrants();
  const now = 1_700_000_000_000;
  const run = { runId: 'run-1', epicKey: 'PAY-1', projectKey: 'PAY', goal: 'refunds' };
  const steps = [
    { stepId: 's0', idx: 0, title: 'Research', workerType: 'research', status: 'queued', input: 'x' },
  ];
  const card = previewBlastRadius({ run, steps, planCard: '' });
  const digest = confirmationToken(card);
  assert.equal(digest, confirmationToken(card));
  assert.equal(acknowledgementText(card).startsWith(`${card.risk.score} points`), true);
  const issued = issueDispatchGrant(card, { now, principal: 'person' });
  assert.equal(issued.confirmToken.startsWith('v2.'), true);
  assert.notEqual(issued.confirmToken, digest);
  const digestRefused = authorizeDispatch({
    confirm: true,
    acknowledgeBlastRadius: acknowledgementText(card),
    confirmToken: digest,
  }, card, now);
  assert.equal(digestRefused.ok, false);
  const accepted = authorizeDispatch({
    confirm: true,
    acknowledgeBlastRadius: issued.acknowledgement,
    confirmToken: issued.confirmToken,
  }, card, now);
  assert.equal(accepted.ok, true);
  const reused = authorizeDispatch({
    confirm: true,
    acknowledgeBlastRadius: issued.acknowledgement,
    confirmToken: issued.confirmToken,
  }, card, now);
  assert.equal(reused.ok, false);
  assert.match(reused.reason, /already used/);
  const later = issueDispatchGrant(card, { now, principal: 'person' });
  const expired = authorizeDispatch({
    confirm: true,
    acknowledgeBlastRadius: later.acknowledgement,
    confirmToken: later.confirmToken,
  }, card, now + CONFIRM_TTL_MS);
  assert.equal(expired.ok, false);
  assert.match(expired.reason, /expired/);
});

test('safety-eval passes every irreversible-action property', async () => {
  const rows = await runSafetyEval();
  assert.ok(rows.length >= 10, `expected at least 10 rows, got ${rows.length}`);
  const failed = rows.filter((row) => row.result !== 'PASS');
  assert.deepEqual(failed, [], formatSafetyReport(rows));
  const classes = [
    'prompt injection',
    'ambiguous instructions',
    'missing information',
    'malformed tool arguments',
    'unusual edge cases',
    'unauthorized requests',
    'bypass approval',
    'expired approvals',
    'timeouts',
    'partial failure',
    'fail-safe',
  ];
  for (const name of classes) {
    assert.ok(rows.some((row) => row.class === name && row.result === 'PASS'), name);
  }
});

test('the naive agent reaches Jira only when safeguards are off', async () => {
  const comparison = await runNaiveComparison();
  assert.equal(comparison.baseline.irreversibleWrites, 6);
  assert.equal(comparison.guarded.irreversibleWrites, 0);
  assert.equal(comparison.guarded.blocked, 6);
});
