import assert from 'node:assert/strict';
import test from 'node:test';

import { canRetry, chaosSummary, effectMetricsSummary, eventAppearance, hasChaosActivity, hasEffectMetrics, isRunning, lozengeAppearance, subAgentLines } from '../status.js';

test('lozenge appearance covers run, step, and effect statuses', () => {
  assert.equal(lozengeAppearance('running'), 'inprogress');
  assert.equal(lozengeAppearance('done'), 'success');
  assert.equal(lozengeAppearance('blocked'), 'removed');
  assert.equal(lozengeAppearance('failed'), 'removed');
  assert.equal(lozengeAppearance('applied'), 'success');
  assert.equal(lozengeAppearance('mystery'), 'default');
});

test('flight-recorder markers use a distinct lozenge', () => {
  assert.equal(eventAppearance('watchdog.self-heal'), 'moved');
  assert.equal(eventAppearance('replan'), 'new');
  assert.equal(eventAppearance('step.succeeded'), 'success');
  assert.equal(eventAppearance('step.failed'), 'removed');
});

test('chaos summary stays quiet until a counter moves', () => {
  assert.equal(chaosSummary(null), '0 injected, 0 healed, 0 duplicate writes');
  assert.equal(hasChaosActivity(null), false);
  assert.equal(hasChaosActivity({ injected: 0, healed: 0, duplicateWrites: 0 }), false);
  assert.equal(
    chaosSummary({ injected: 3, healed: 3, duplicateWrites: 0 }),
    '3 injected, 3 healed, 0 duplicate writes',
  );
  assert.equal(hasChaosActivity({ injected: 1, healed: 0, duplicateWrites: 0 }), true);
});

test('effect metrics stay quiet until a counter moves', () => {
  assert.equal(effectMetricsSummary(null), '0 applied, 0 deduped, 0 retried');
  assert.equal(hasEffectMetrics(null), false);
  assert.equal(hasEffectMetrics({ applied: 0, deduped: 0, retried: 0 }), false);
  assert.equal(
    effectMetricsSummary({ applied: 4, deduped: 1, retried: 1 }),
    '4 applied, 1 deduped, 1 retried',
  );
  assert.equal(hasEffectMetrics({ applied: 0, deduped: 0, retried: 1 }), true);
});

test('retry is offered only for failed and blocked steps', () => {
  assert.equal(canRetry('failed'), true);
  assert.equal(canRetry('blocked'), true);
  assert.equal(canRetry('running'), false);
  assert.equal(isRunning('running'), true);
});

test('sub-agent lines show the brief and stay empty without one', () => {
  assert.deepEqual(subAgentLines({}), []);
  const lines = subAgentLines({
    idx: 0,
    skill: 'research',
    workerType: 'research',
    brief: {
      objective: 'Find refund issues. Goal: Ship refunds',
      allowedTools: ['searchIssues'],
      doneWhen: 'The summary names the related issues.',
      budget: { maxToolCalls: 4, maxOutputBytes: 2048, maxRepairAttempts: 1 },
    },
  });
  assert.equal(lines.length, 4);
  assert.match(lines[0], /research/);
  assert.match(lines[1], /searchIssues/);
  assert.match(lines[2], /Done when/);
  assert.match(lines[3], /2048/);
});
