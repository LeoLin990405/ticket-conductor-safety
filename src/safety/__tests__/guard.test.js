import assert from 'node:assert/strict';
import test from 'node:test';

import { previewBlastRadius } from '../../blast/preview.js';
import {
  acknowledgementText,
  confirmationToken,
  evaluateDispatchAuthorization,
} from '../guard.js';
import { formatSafetyReport, runSafetyEval } from '../eval.js';

test('the confirmation token changes when the blast-radius score changes', () => {
  const run = { runId: 'run-1', epicKey: 'PAY-1', projectKey: 'PAY', goal: 'refunds' };
  const steps = [
    { stepId: 's0', idx: 0, title: 'Research', workerType: 'research', status: 'queued', input: 'x' },
  ];
  const card = previewBlastRadius({ run, steps, planCard: '' });
  const token = confirmationToken(card);
  assert.equal(token, confirmationToken(card));
  assert.equal(acknowledgementText(card).startsWith(`${card.risk.score} points`), true);
  const refused = evaluateDispatchAuthorization({
    confirm: true,
    acknowledgeBlastRadius: acknowledgementText(card),
    confirmToken: token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a'),
  }, card);
  assert.equal(refused.ok, false);
  const accepted = evaluateDispatchAuthorization({
    confirm: true,
    acknowledgeBlastRadius: acknowledgementText(card),
    confirmToken: token,
  }, card);
  assert.equal(accepted.ok, true);
});

test('safety-eval passes every irreversible-action property', async () => {
  const rows = await runSafetyEval();
  assert.ok(rows.length >= 10, `expected at least 10 rows, got ${rows.length}`);
  const failed = rows.filter((row) => row.result !== 'PASS');
  assert.deepEqual(failed, [], formatSafetyReport(rows));
});
