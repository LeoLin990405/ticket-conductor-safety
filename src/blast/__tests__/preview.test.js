import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { requestKeyFor } from '../../effects/requestKey.js';
import { buildCreateIssuePayload } from '../../run/stateMachine.js';
import {
  BLAST_CARD_BUDGET,
  BLAST_JOURNAL_BUDGET,
  BLAST_THRESHOLD,
  BEFORE_SNAPSHOT_BUDGET,
  CLOSE_STATUS_NAME,
  ROLLBACK_LABEL,
  accountPreviewWrites,
  compensationApplies,
  fitBeforeSnapshot,
  gateInsertion,
  isRollbackResidue,
  journalDetail,
  panelModel,
  planCardFromSteps,
  planCompensations,
  plannedRequestKey,
  previewBlastRadius,
} from '../preview.js';

const RUN = {
  runId: 'run-1',
  epicKey: 'PAY-1',
  projectKey: 'PAY',
  goal: 'Ship payment refunds',
};

/**
 * @param {number} count
 * @param {string} [workerType]
 * @param {object} [extra]
 */
function steps(count, workerType = 'research', extra = {}) {
  return Array.from({ length: count }, (_, idx) => ({
    stepId: `step-${idx}`,
    idx,
    title: `Step ${idx}`,
    workerType,
    status: 'queued',
    dependsOn: [],
    ...extra,
  }));
}

test('planned request keys match requestKeyFor for the kinds the queue accepts', () => {
  for (const kind of [
    'createIssue',
    'comment',
    'transition',
    'closeIssue',
    'recordRemovedComment',
    'restoreStatus',
  ]) {
    const input = {
      runId: 'run-1',
      stepId: 'step-1',
      kind,
      discriminator: 'child-issue',
    };
    assert.equal(plannedRequestKey(input), requestKeyFor(input));
  }
  assert.equal(
    plannedRequestKey({
      runId: 'run-1',
      stepId: null,
      kind: 'comment',
      discriminator: 'memory:epic-comment',
    }),
    requestKeyFor({
      runId: 'run-1',
      kind: 'comment',
      discriminator: 'memory:epic-comment',
    }),
  );
  assert.throws(
    () => requestKeyFor({
      runId: 'run-1',
      stepId: 'step-1',
      kind: 'setFields',
      discriminator: 'fields:summary',
    }),
    { name: 'EffectValidationError' },
  );
});

test('a three-step plan lists every template write and does not gate', () => {
  const plan = [
    { stepId: 's0', idx: 0, title: 'Research refunds', workerType: 'research', skill: 'research', status: 'queued', dependsOn: [] },
    { stepId: 's1', idx: 1, title: 'Check capture links', workerType: 'check-deps', skill: 'check-deps', status: 'queued', dependsOn: [] },
    { stepId: 's2', idx: 2, title: 'Draft the refund spec', workerType: 'draft-spec', skill: 'draft-spec', status: 'queued', dependsOn: [0, 1] },
  ];
  const card = previewBlastRadius({ run: RUN, steps: plan, planCard: 'Lesson abc' });

  const certain = card.writes.filter((write) => write.certainty === 'certain');
  const creates = certain.filter((write) => write.kind === 'createIssue');
  const comments = certain.filter((write) => write.kind === 'comment');
  assert.equal(creates.length, 3);
  assert.deepEqual(
    comments.map((write) => write.template),
    ['research-comment', 'check-deps-comment', 'draft-spec-comment', 'plan:lesson-citation'],
  );
  assert.equal(card.counts.transitions, 0);
  assert.equal(card.counts.fieldChanges, 0);
  assert.equal(card.writes.some((write) => write.template === 'memory:epic-comment' && write.certainty === 'if-done'), true);
  assert.equal(card.writes.some((write) => write.template === 'summarize-comment'), false);
  assert.equal(card.writes.some((write) => write.template === 'wave-report'), false);
  assert.equal(card.omitted.some((entry) => entry.template === 'watchdog-blocked'), true);
  assert.equal(card.risk.exceeds, false);
  assert.equal(card.gate.insert, false);
  assert.equal(card.overBudget, false);
  assert.ok(card.bytes <= BLAST_CARD_BUDGET);
  assert.equal(JSON.stringify(card).includes('Goal:'), false);

  const research = creates[0];
  assert.equal(research.requestKey, requestKeyFor({
    runId: RUN.runId,
    stepId: 's0',
    kind: 'createIssue',
    discriminator: 'child-issue',
  }));
  const payload = buildCreateIssuePayload(RUN, plan[0]);
  assert.equal(payload.issueType, 'Sub-task');
  assert.equal(payload.parentKey, RUN.epicKey);
  assert.equal(research.issueType, payload.issueType);
  assert.equal(research.fields.find((field) => field.field === 'summary').to, payload.summary);
});

test('checklist skills comment with skill-full-output and a fork prefix is omitted', () => {
  const card = previewBlastRadius({
    run: RUN,
    steps: [
      { stepId: 'done', idx: 0, title: 'Already ran', workerType: 'research', status: 'done', dependsOn: [] },
      { stepId: 'risk', idx: 1, title: 'Review refund risks', workerType: 'risk-review', skill: 'risk-review', status: 'queued', dependsOn: [0] },
    ],
  });
  assert.deepEqual(
    card.writes.filter((write) => write.certainty === 'certain').map((write) => write.template),
    ['child-issue', 'skill-full-output'],
  );
  assert.equal(card.risk.score, 1);
});

test('a transition or field edit on the epic trips the gate without a big plan', () => {
  const plan = [{
    stepId: 's0',
    idx: 0,
    title: 'Move the epic',
    workerType: 'check-deps',
    status: 'queued',
    dependsOn: [],
    input: {
      transitionTo: 'In Progress',
      transitionTarget: 'epic',
      fields: { labels: 'needs-review' },
      fieldsTarget: 'child',
    },
  }];
  const card = previewBlastRadius({ run: RUN, steps: plan });
  const transition = card.writes.find((write) => write.kind === 'transition');
  const fields = card.writes.find((write) => write.kind === 'setFields');
  assert.equal(transition.target.type, 'epic');
  assert.equal(transition.target.issueKey, 'PAY-1');
  assert.equal(fields.target.type, 'child-of-step');
  assert.equal(card.risk.external, true);
  assert.equal(card.gate.insert, true);
  assert.deepEqual(card.gate.waitFor, [0]);
  assert.equal(card.gate.fits, true);
  assert.equal(card.gate.appendedIdx, 1);

  const inserted = gateInsertion(card, plan);
  assert.equal(inserted.insert, true);
  assert.equal(inserted.steps[0].dependsOn[0], 1);
  assert.equal(inserted.steps[1].workerType, 'approval');
  assert.deepEqual(inserted.steps[1].dependsOn, []);

  const again = previewBlastRadius({
    run: RUN,
    steps: inserted.steps.map((step, index) => ({
      ...step,
      stepId: step.stepId || `gate-${index}`,
    })),
  });
  assert.equal(again.gate.insert, false);
  assert.equal(again.risk.score, card.risk.score);
});

test('five child issues gate and still fit; eight issues do not grow a ninth step', () => {
  const five = previewBlastRadius({ run: RUN, steps: steps(5) });
  assert.equal(five.risk.score, 5);
  assert.equal(five.risk.exceeds, true);
  assert.equal(five.gate.fits, true);
  const inserted = gateInsertion(five, steps(5));
  assert.equal(inserted.steps.length, 6);
  assert.ok(inserted.steps.slice(0, 5).every((step) => step.dependsOn.includes(5)));

  const eight = previewBlastRadius({ run: RUN, steps: steps(8, 'draft-spec') });
  assert.equal(eight.gate.insert, true);
  assert.equal(eight.gate.fits, false);
  assert.equal(eight.gate.appendedIdx, null);
  const refused = gateInsertion(eight, steps(8, 'draft-spec'));
  assert.equal(refused.insert, false);
  assert.equal(refused.steps.length, 8);
  assert.equal(eight.overBudget, false);
  const heavy = steps(8, 'draft-spec', {
    input: {
      issueType: 'Story',
      transitionTo: 'In Progress',
      transitionTarget: 'epic',
      fields: { summary: 'Replacement summary', labels: 'needs-review' },
      fieldsTarget: 'epic',
    },
  });
  const heavyCard = previewBlastRadius({
    run: { ...RUN, goal: 'Ship payment refunds that stay idempotent on the payment id' },
    steps: heavy,
    planCard: 'Lesson abc cites the billing timeout',
  });
  assert.equal(heavyCard.counts.issues, 8);
  assert.equal(heavyCard.counts.transitions, 8);
  assert.equal(heavyCard.counts.fieldChanges, 8);
  assert.equal(heavyCard.overBudget, false);
  assert.ok(heavyCard.bytes <= BLAST_CARD_BUDGET);
  assert.ok(journalDetail(eight).requestKeys.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(journalDetail(eight)), 'utf8') <= BLAST_JOURNAL_BUDGET);
  assert.equal(eight.risk.threshold, BLAST_THRESHOLD);
});

test('a mocked jira client is never called while the card is built', () => {
  const jira = {
    calls: 0,
    requestJira() {
      jira.calls += 1;
      throw new Error('preview must not call Jira');
    },
  };
  const card = previewBlastRadius({
    run: RUN,
    steps: steps(3),
    jira,
  });
  assert.equal(jira.calls, 0);
  assert.equal(card.phase, 'preview');
  assert.equal(card.counts.issues, 3);
});

test('a lesson citation on a queued step turns on the plan comment, a done prefix does not', () => {
  const cited = planCardFromSteps([
    {
      stepId: 'done',
      idx: 0,
      status: 'done',
      input: { citation: 'Lesson old: copied from the prefix' },
    },
    {
      stepId: 'check',
      idx: 1,
      status: 'queued',
      input: { citation: 'Lesson abc: check the billing dependency' },
    },
  ]);
  assert.equal(cited, 'Lesson abc: check the billing dependency');
  assert.equal(planCardFromSteps([
    { stepId: 's0', status: 'queued', input: 'Ship payment refunds' },
  ]), '');
});

test('accounted writes match a mocked Jira log and leave only the omitted wave report', () => {
  const plan = [
    { stepId: 's0', idx: 0, title: 'Research refunds', workerType: 'research', status: 'queued', dependsOn: [] },
    { stepId: 's1', idx: 1, title: 'Check capture links', workerType: 'check-deps', status: 'queued', dependsOn: [0] },
    { stepId: 's2', idx: 2, title: 'Draft the refund spec', workerType: 'draft-spec', status: 'queued', dependsOn: [1] },
  ];
  const card = previewBlastRadius({ run: RUN, steps: plan });
  const mutations = [
    { kind: 'createIssue', issueKey: 'PAY-101', summary: 'Research refunds', parentKey: 'PAY-1' },
    { kind: 'createIssue', issueKey: 'PAY-102', summary: 'Check capture links', parentKey: 'PAY-1' },
    { kind: 'createIssue', issueKey: 'PAY-103', summary: 'Draft the refund spec', parentKey: 'PAY-1' },
    { kind: 'comment', issueKey: 'PAY-101', commentId: '1', bodyText: 'Research notes' },
    { kind: 'comment', issueKey: 'PAY-102', commentId: '2', bodyText: 'No linked issues on PAY-102.' },
    { kind: 'comment', issueKey: 'PAY-103', commentId: '3', bodyText: 'Draft' },
    { kind: 'comment', issueKey: 'PAY-1', commentId: '4', bodyText: '[Conductor wave]\nWave 1 finished.' },
    { kind: 'comment', issueKey: 'PAY-1', commentId: '5', bodyText: '[Conductor memory]\nDone.' },
  ];
  const account = accountPreviewWrites(card, mutations, {
    finished: true,
    epicKey: 'PAY-1',
    childIssueKeys: { s0: 'PAY-101', s1: 'PAY-102', s2: 'PAY-103' },
  });
  assert.deepEqual(account.missing, []);
  assert.deepEqual(account.extra, []);
  assert.equal(account.acknowledged.length, 1);
  assert.equal(account.acknowledged[0].template, 'wave-report');
  assert.equal(account.paired, card.writes.filter((write) => (
    write.certainty === 'certain' || write.certainty === 'if-done'
  )).length);

  const drifted = accountPreviewWrites(card, mutations.slice(0, 6), {
    finished: true,
    epicKey: 'PAY-1',
    childIssueKeys: { s0: 'PAY-101', s1: 'PAY-102', s2: 'PAY-103' },
  });
  assert.equal(drifted.missing.length, 1);
  assert.equal(drifted.missing[0].template, 'memory:epic-comment');

  const surprise = accountPreviewWrites(card, [
    ...mutations,
    { kind: 'transition', issueKey: 'PAY-1', toStatusName: 'Done' },
  ], {
    finished: true,
    epicKey: 'PAY-1',
    childIssueKeys: { s0: 'PAY-101', s1: 'PAY-102', s2: 'PAY-103' },
  });
  assert.equal(surprise.extra.length, 1);
  assert.equal(surprise.extra[0].kind, 'transition');
});

test('the panel model is plain text for UI Kit', () => {
  const card = previewBlastRadius({ run: RUN, steps: steps(3) });
  const model = panelModel(card);
  assert.equal(model.title, 'Blast radius');
  assert.equal(model.appearance, 'information');
  assert.match(model.summary, /^3 child issues, 4 comments \(1 after the run finishes\), 0 transitions, 0 field changes$/);
  assert.equal(model.rows.length, card.writes.length);
  assert.equal(typeof model.rows[0].cells[0].content, 'string');
});

test('undo closes a created child after its comment is recorded removed', () => {
  const plan = planCompensations([
    {
      requestKey: 'create-1',
      runId: 'run-1',
      stepId: 'step-1',
      kind: 'createIssue',
      status: 'applied',
      appliedAt: 100,
      payload: {},
      result: { issueKey: 'PAY-101' },
    },
    {
      requestKey: 'comment-1',
      runId: 'run-1',
      stepId: 'step-1',
      kind: 'comment',
      status: 'applied',
      appliedAt: 200,
      payload: { childOfStepId: 'step-1' },
      result: { commentId: '10001' },
    },
    {
      requestKey: 'pending-1',
      runId: 'run-1',
      stepId: 'step-1',
      kind: 'comment',
      status: 'pending',
      payload: { issueKey: 'PAY-101' },
      result: {},
    },
  ]);

  assert.deepEqual(plan.compensations.map((item) => item.kind), [
    'recordRemovedComment',
    'closeIssue',
  ]);
  const [removed, closed] = plan.compensations;
  assert.deepEqual(removed.payload, { issueKey: 'PAY-101', commentId: '10001' });
  assert.deepEqual(closed.payload, {
    issueKey: 'PAY-101',
    toStatusName: CLOSE_STATUS_NAME,
    label: ROLLBACK_LABEL,
  });
  assert.deepEqual(closed.dependsOnKeys, [removed.requestKey]);
  assert.equal(closed.payload.toStatusName === 'Done' && !('delete' in closed.payload), true);
  assert.equal(plan.skipped.some((item) => item.reason === 'not-applied'), true);
  assert.deepEqual(plan.irreversible, [
    'closed-child-remains',
    'kvs-memory-kept',
    'flight-recorder-append-only',
  ]);

  const again = planCompensations([
    ...plan.compensations.map((item) => ({
      ...item,
      status: 'applied',
      kind: item.kind,
    })),
    {
      requestKey: 'create-1',
      runId: 'run-1',
      stepId: 'step-1',
      kind: 'createIssue',
      status: 'applied',
      appliedAt: 100,
      result: { issueKey: 'PAY-101' },
    },
    {
      requestKey: 'comment-1',
      runId: 'run-1',
      stepId: 'step-1',
      kind: 'comment',
      status: 'applied',
      appliedAt: 200,
      payload: { childOfStepId: 'step-1' },
      result: { commentId: '10001' },
    },
  ]);
  assert.deepEqual(
    again.compensations.map((item) => item.requestKey),
    plan.compensations.map((item) => item.requestKey),
  );
});

test('status is restored only for an issue this run did not create, and only with a snapshot', () => {
  const missing = planCompensations([
    {
      requestKey: 'trans-1',
      runId: 'run-1',
      stepId: 'step-1',
      kind: 'transition',
      status: 'applied',
      payload: { issueKey: 'PAY-1', toStatusName: 'In Progress' },
      result: { transitionId: '21' },
    },
  ]);
  assert.equal(missing.cannotUndo[0].reason, 'no-before-snapshot');
  assert.equal(missing.compensations.length, 0);

  const epic = planCompensations([
    {
      requestKey: 'trans-1',
      runId: 'run-1',
      stepId: 'step-1',
      kind: 'transition',
      status: 'applied',
      appliedAt: 50,
      payload: { issueKey: 'PAY-1', toStatusName: 'In Progress' },
      result: {
        transitionId: '21',
        before: { statusName: 'To Do' },
        after: { statusName: 'In Progress' },
      },
    },
  ]);
  assert.equal(epic.compensations[0].kind, 'restoreStatus');
  assert.equal(epic.compensations[0].payload.toStatusName, 'To Do');
  assert.deepEqual(
    compensationApplies(epic.compensations[0], { statusName: 'In Progress' }),
    { apply: true, reason: '' },
  );
  assert.deepEqual(
    compensationApplies(epic.compensations[0], { statusName: 'Done' }),
    { apply: false, reason: 'status-drift' },
  );

  const onChild = planCompensations([
    {
      requestKey: 'create-1',
      runId: 'run-1',
      stepId: 'step-1',
      kind: 'createIssue',
      status: 'applied',
      result: { issueKey: 'PAY-101' },
    },
    {
      requestKey: 'trans-child',
      runId: 'run-1',
      stepId: 'step-1',
      kind: 'transition',
      status: 'applied',
      payload: { issueKey: 'PAY-101', toStatusName: 'In Progress' },
      result: { before: { statusName: 'To Do' }, after: { statusName: 'In Progress' } },
    },
  ]);
  assert.equal(onChild.compensations.some((item) => item.kind === 'restoreStatus'), false);
  assert.equal(onChild.skipped.some((item) => item.reason === 'covered-by-close'), true);
});

test('field restore keeps the previous values and refuses drift', () => {
  const plan = planCompensations([
    {
      requestKey: 'fields-1',
      runId: 'run-1',
      stepId: 'step-9',
      kind: 'setFields',
      status: 'applied',
      payload: { issueKey: 'PAY-3' },
      result: {
        before: { fields: { summary: 'Refund API' } },
        after: { fields: { summary: 'Refund API (edited)' } },
      },
    },
  ]);
  const restore = plan.compensations[0];
  assert.equal(restore.kind, 'restoreFields');
  assert.equal(restore.payload.fields.summary, 'Refund API');
  assert.deepEqual(
    compensationApplies(restore, { fields: { summary: 'someone else edited this' } }),
    { apply: false, reason: 'field-drift' },
  );
});

test('before snapshots and residue issues stay inside the documented bounds', () => {
  const huge = { statusName: 'To Do', fields: {} };
  for (let index = 0; index < 80; index += 1) {
    huge.fields[`field${index}`] = 'x'.repeat(80);
  }
  const fitted = fitBeforeSnapshot(huge);
  assert.equal(fitted.statusName, 'To Do');
  assert.ok(Buffer.byteLength(JSON.stringify(fitted), 'utf8') <= BEFORE_SNAPSHOT_BUDGET);
  assert.ok(Object.keys(fitted.fields).length < 80);
  assert.equal(isRollbackResidue({
    fields: { status: { name: 'Done' }, labels: [ROLLBACK_LABEL] },
  }), true);
  assert.equal(isRollbackResidue({
    fields: { status: { name: 'To Do' }, labels: [ROLLBACK_LABEL] },
  }), false);
});

test('the preview is wired into plan, dispatch, and the panel, and the UI bundle does not import it', () => {
  const wired = [
    '../../../src/actions/index.js',
    '../../../src/run/stateMachine.js',
    '../../../src/resolvers/panelData.js',
  ];
  for (const file of wired) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(text.includes('blast/preview'), true, file);
  }
  // The UI Kit bundle must not import this module: it uses node:crypto.
  // `src/effects/jira.js` may import the snapshot helper. The panel must not.
  const unwired = [
    '../../../src/index.js',
    '../../../src/effects/index.js',
    '../../../src/effects/applier.js',
    '../../../src/run/leadLoop.js',
    '../../../src/frontend/index.jsx',
    '../../../src/recorder/replay.js',
    '../../../manifest.yml',
  ];
  for (const file of unwired) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(text.includes('blast/preview'), false, file);
    assert.equal(text.includes('src/blast'), false, file);
  }
});
