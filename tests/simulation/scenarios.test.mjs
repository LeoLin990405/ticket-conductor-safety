/**
 * End-to-end scenarios on the in-memory Forge runtime.
 *
 * Each case drives the real action handlers, the step worker, the effect
 * applier, the lead loop, and the watchdog. The platform underneath is the
 * fakes in `./fakes.mjs`. No test contacts Atlassian, and none of them read
 * a secret.
 *
 * The cases share one Node process (the store singleton, the fault
 * schedule, the effect clock), so they run through `testSerial` and must
 * not overlap. `node --test` gives this file its own process.
 *
 * Order is not significant. `SIM_SCENARIO_ORDER=reverse` runs the queue
 * backwards. `SIM_SCENARIO_ORDER=shuffle` and `SIM_SCENARIO_SEED` (default
 * `20261121`) run a seeded shuffle. `startSerialScenarios()` at the bottom
 * of this file is what registers those cases with the runner.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultStepsJson } from '../../src/actions/handoff.js';
import {
  FAULT_INJECTION_ENV,
  faultInjectionResidue,
  injectFault,
  resetFaultInjection,
  SIMULATION_ENV,
} from '../../src/chaos/faults.js';
import { accountPreviewWrites, isRollbackResidue, planCompensations, plannedRequestKey, previewBlastRadius } from '../../src/blast/preview.js';
import { RETRY_BASE_SECONDS } from '../../src/effects/applier.js';
import { effectApplierHandler, enqueueCompensations } from '../../src/effects/index.js';
import { requestKeyFor } from '../../src/effects/requestKey.js';
import { chaosSummary, effectMetricsSummary, hasChaosActivity, hasEffectMetrics } from '../../src/frontend/status.js';
import { acceptLesson, addLesson, listLessons } from '../../src/memory/index.js';
import { DIGEST_BYTE_BUDGET } from '../../src/run/digest.js';
import {
  RUN_MAX_MODEL_CALLS,
  RUN_MAX_STEPS,
  RUN_WALL_CLOCK_MS,
  isWithinRunBudget,
} from '../../src/run/budget.js';
import {
  REPLAN_MERGED,
  REPLAN_WITHIN_BUDGET,
  criticalPathOf,
} from '../../src/run/criticalPath.js';
import { approveGate } from '../../src/run/approval.js';
import { STEP_DEADLINE_MS } from '../../src/run/dependencies.js';
import { STUCK_QUEUED_MS } from '../../src/store/types.js';
import { loadRun } from '../../src/resolvers/panelData.js';
import { childIssueUpdated } from '../../src/triggers/childIssueUpdated.js';
import { doc, paragraph, textNode } from '../../src/worker/adf.js';
import { untrustedTagCounts } from '../../src/worker/guard.js';
import { registerWorkerType } from '../../src/worker/index.js';
import { markActive, shouldScan } from '../../src/watchdog/gate.js';

import {
  assertWithinBudget,
  buildHeadroomRow,
  formatHeadroomReport,
  headroomFailures,
  headroomWarnings,
  KVS_HEADROOM_WARN_RATIO,
  scenarioHeadroom,
} from './budget.mjs';
import {
  createSimulationKvs,
  DEMO_KEYS,
  INJECTION_TOKEN,
  KVS_BYTE_FLOOR,
  PROMPT_INJECTION,
} from './fakes.mjs';
import {
  createWorld,
  orderSerialCases,
  scenarioOrderDescription,
  startSerialScenarios,
  testSerial,
} from './world.mjs';

const GOAL = 'Ship payment refunds';
// Medium effort: the lead may add two follow-ups, so wave 2 can run in parallel.
const DAG_GOAL = 'Ship payment refunds that stay idempotent on the payment id';
// Lives only on a worker finding, never on the short summary the digest keeps.
// A later wave, the lead prompt, or another child comment must not carry it.
const FULL_OUTPUT_MARKER = 'FULL-OUTPUT-MARKER-not-for-the-lead';

/**
 * Jira mutations, not searches. A redelivery that only re-reads is fine.
 *
 * @param {object} world
 * @returns {number}
 */
function jiraWriteCount(world) {
  return world.jira.calls.filter((call) => call.method !== 'GET').length;
}

/**
 * Text with every `<untrusted>` block removed, so a leaked instruction is
 * visible and a fenced copy of ticket text is not.
 *
 * @param {string} text
 * @returns {string}
 */
function outsideUntrusted(text) {
  return String(text).replace(/<untrusted\b[^>]*>[\s\S]*?<\/untrusted>/g, '');
}

/**
 * The one line `buildBrief` quotes from `dependencyContext`. Kept here so
 * the scenario can require that exact quote, not merely that some string
 * on the step changed.
 *
 * @param {{idx?: number, output?: {summary?: string}}} entry
 * @returns {string}
 */
function upstreamQuote(entry) {
  const output = entry?.output;
  const record = output !== null && typeof output === 'object' ? output : {};
  const summary = typeof record.summary === 'string' ? record.summary : '';
  const text = summary.replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${entry?.idx ?? '?'}: ${text}`;
}

/**
 * One created child per planned step. Summarize aggregates; it has no child.
 *
 * @param {object} world
 * @param {Array<object>} steps
 */
function assertOneChildPerWorkStep(world, steps) {
  const work = steps.filter((step) => step.workerType !== 'summarize');
  const creates = world.jira.mutationsOf('createIssue');
  assert.equal(creates.length, work.length, 'one createIssue per work step');
  const seen = new Set();
  for (const step of work) {
    assert.equal(typeof step.childIssueKey, 'string', `${step.title} childIssueKey`);
    assert.equal(seen.has(step.childIssueKey), false, `duplicate child ${step.childIssueKey}`);
    seen.add(step.childIssueKey);
    const created = creates.find((create) => create.issueKey === step.childIssueKey);
    assert.ok(created, `${step.title} was not created in Jira`);
    assert.equal(created.summary, step.title);
  }
  const summarize = steps.find((step) => step.workerType === 'summarize');
  if (summarize) {
    assert.equal(summarize.childIssueKey ?? null, null);
  }
}

/**
 * The child-issue effect and the child comment effect each exist once, applied
 * on the first try. A wave report shares the anchor step id but targets the
 * Epic, so it is not the child comment.
 *
 * @param {object} world
 * @param {string} runId
 * @param {Array<object>} steps
 * @param {string} epicKey
 */
async function assertChildEffectsOnce(world, runId, steps, epicKey) {
  const effects = await world.store.listEffectsByRun(runId);
  const work = steps.filter((step) => step.workerType !== 'summarize');
  for (const step of work) {
    const creates = effects.filter((effect) =>
      effect.stepId === step.stepId && effect.kind === 'createIssue');
    assert.equal(creates.length, 1, `${step.title} createIssue effect`);
    assert.equal(creates[0].status, 'applied');
    assert.equal(creates[0].tries, 1);
    assert.equal(creates[0].result.issueKey, step.childIssueKey);

    const childComments = effects.filter((effect) =>
      effect.stepId === step.stepId
      && effect.kind === 'comment'
      && effect.payload?.issueKey !== epicKey);
    assert.equal(childComments.length, 1, `${step.title} child comment effect`);
    assert.equal(childComments[0].status, 'applied');
    assert.equal(childComments[0].tries, 1);
    assert.equal(typeof childComments[0].result.commentId, 'string');
  }
}

/**
 * @param {object} world
 * @param {string} epicKey
 * @param {{memory?: number, waves?: number, plans?: number}} [expected]
 */
function assertCommentLedger(world, epicKey, expected = {}) {
  const memoryCount = expected.memory ?? 1;
  const waveCount = expected.waves ?? 0;
  const planCount = expected.plans ?? 0;
  const creates = world.jira.mutationsOf('createIssue');
  const comments = world.jira.mutationsOf('comment');
  const childKeys = new Set(creates.map((create) => create.issueKey));

  for (const key of childKeys) {
    const onChild = comments.filter((comment) => comment.issueKey === key);
    assert.equal(
      onChild.length,
      1,
      `child ${key} should have one comment, has ${onChild.length}`,
    );
  }

  const epic = comments.filter((comment) => comment.issueKey === epicKey);
  const memory = epic.filter((comment) => comment.bodyText.startsWith('[Conductor memory]'));
  const waves = epic.filter((comment) => comment.bodyText.startsWith('[Conductor wave]'));
  const plans = epic.filter((comment) => comment.bodyText.startsWith('[Conductor plan]'));
  const other = epic.filter((comment) =>
    !comment.bodyText.startsWith('[Conductor memory]')
    && !comment.bodyText.startsWith('[Conductor wave]')
    && !comment.bodyText.startsWith('[Conductor plan]')
    && !comment.bodyText.startsWith('[Conductor watchdog]'),
  );
  assert.equal(memory.length, memoryCount, 'Epic memory comments');
  assert.equal(waves.length, waveCount, 'Epic wave reports');
  assert.equal(plans.length, planCount, 'Epic plan cards');
  assert.deepEqual(other, [], 'unexpected Epic comment');
  assert.equal(world.jira.mutationsOf('transition').length, 0, 'no transitions');
  assert.deepEqual(world.fetches, [], 'fetch was called');
  for (const call of world.jira.calls) {
    assert.equal(call.pathname.startsWith('/rest/api/3/'), true, call.path);
  }
}

/**
 * Scripted model for the lead-loop scenario.
 * Wave 1 spawns two parallel follow-ups. Wave 2 stops.
 * Workers return JSON the real parsers accept.
 *
 * @param {{system: string, user: string}} prompt
 * @returns {string}
 */
function dagReply({ system, user }) {
  if (system.includes('lead of Ticket Conductor')) {
    if (user.includes('Wave 1 just finished')) {
      return JSON.stringify({
        action: 'spawn',
        why: 'Add a test plan and a risk review. They do not depend on each other.',
        steps: [
          { title: 'Write the refund test plan', workerType: 'test-plan' },
          { title: 'Review refund risks', workerType: 'risk-review' },
        ],
      });
    }
    return JSON.stringify({
      action: 'stop',
      why: 'The follow-up wave covered the goal.',
      steps: [],
    });
  }
  if (user.includes('Task: research.')) {
    return JSON.stringify({
      summary: 'Refunds stay idempotent on the payment id.',
      findings: [{ key: 'PAY-3', why: `The refund API story is the related change. ${FULL_OUTPUT_MARKER}` }],
      gaps: [],
    });
  }
  if (user.includes('Task: check-deps.')) {
    return JSON.stringify({
      summary: 'The reconcile epic is linked and still open.',
      risks: [{ key: 'PAY-2', risk: 'Ledger reconcile is not done.' }],
    });
  }
  if (user.includes('Task: draft-spec.')) {
    return JSON.stringify({
      summary: 'Specify an idempotent refund API.',
      problem: 'A duplicate refund must not write a second ledger line.',
      proposal: 'Key the refund on the payment id.',
      acceptanceCriteria: ['A repeat POST returns the original refund.'],
      outOfScope: ['Chargeback handling.'],
      openQuestions: [],
    });
  }
  if (user.includes('Task: summarize.')) {
    return JSON.stringify({
      summary: 'Refunds are idempotent on the payment id.',
      lessons: [{ text: 'Key refunds on the payment id.', type: 'decision' }],
    });
  }
  throw new Error(`dag script has no reply for this prompt: ${user.slice(0, 80)}`);
}

/**
 * Research output that asks a person and names a follow-up the lead can spawn.
 *
 * @param {{system: string, user: string}} prompt
 */
function approvalReply({ system, user }) {
  if (system.includes('lead of Ticket Conductor')) {
    throw new Error('lead model timed out');
  }
  if (user.includes('Task: research.')) {
    return JSON.stringify({
      summary: 'The refund policy needs approval before we touch the unknown dependency on capture.',
      findings: [{ key: 'PAY-3', why: `Related refund work. ${FULL_OUTPUT_MARKER}` }],
      gaps: ['unknown dependency on the capture service'],
    });
  }
  if (user.includes('Task: check-deps.')) {
    return JSON.stringify({
      summary: 'No further blocker once the capture link is noted.',
      risks: [],
    });
  }
  if (user.includes('Task: summarize.')) {
    return JSON.stringify({
      summary: 'A person approved the follow-up and the run finished.',
      lessons: [],
    });
  }
  throw new Error(`approval script has no reply for this prompt: ${user.slice(0, 80)}`);
}

/**
 * Model that copies the injection into the summary and adds fields the
 * worker must ignore. Findings stay on keys the search actually returned.
 *
 * @param {{system: string, user: string}} prompt
 */
function injectionReply({ user }) {
  if (user.includes('Task: research.')) {
    return JSON.stringify({
      summary: `${PROMPT_INJECTION} ${INJECTION_TOKEN}`,
      findings: [{ key: 'PAY-3', why: 'Quoted from the ticket, not executed.' }],
      gaps: [],
      effects: [{ kind: 'transition', payload: { issueKey: 'PAY-1', toStatusName: 'Done' } }],
      fetch: 'https://example.com/plan',
    });
  }
  if (user.includes('Task: summarize.')) {
    return JSON.stringify({
      summary: 'The run stored the ticket text and did not act on it.',
      lessons: [],
    });
  }
  return JSON.stringify({ summary: 'Template stand-in.', lessons: [] });
}

test('KVS fake bills query pages and the 1 KiB floor', async () => {
  const sdk = createSimulationKvs();
  await sdk.kvs.entity('run').set('r1', { epicKey: 'PAY-1', createdAt: 5, status: 'planning', updatedAt: 5 });
  const afterWrite = sdk.usage();
  assert.ok(afterWrite.writes >= KVS_BYTE_FLOOR);
  assert.equal(afterWrite.reads, 0);

  const missing = await sdk.kvs.entity('run').get('missing');
  assert.equal(missing, undefined);
  const afterMiss = sdk.usage();
  assert.equal(afterMiss.reads, KVS_BYTE_FLOOR);

  const page = await sdk.kvs.entity('run').query()
    .index('by-epic', { partition: ['PAY-1'] })
    .where(sdk.WhereConditions.greaterThan(0))
    .sort(sdk.Sort.ASC)
    .limit(10)
    .getMany();
  assert.equal(page.results.length, 1);
  assert.equal(page.results[0].key, 'r1');
  assert.ok(sdk.usage().reads > afterMiss.reads);

  const beforeEmpty = sdk.usage().reads;
  const empty = await sdk.kvs.entity('run').query()
    .index('by-epic', { partition: ['NONE'] })
    .limit(10)
    .getMany();
  assert.equal(empty.results.length, 0);
  assert.equal(sdk.usage().reads - beforeEmpty, KVS_BYTE_FLOOR);
  assert.ok(sdk.usage().queries >= 2);
});

test('scenario order reverse and shuffle do not depend on the clock', () => {
  const cases = ['a', 'b', 'c', 'd'].map((name) => ({ name, fn: async () => {} }));
  assert.deepEqual(
    orderSerialCases(cases, 'source', 1).map((item) => item.name),
    ['a', 'b', 'c', 'd'],
  );
  assert.deepEqual(
    orderSerialCases(cases, 'reverse', 1).map((item) => item.name),
    ['d', 'c', 'b', 'a'],
  );
  // Source order is a copy. Reversing the result must not reverse the input.
  assert.deepEqual(cases.map((item) => item.name), ['a', 'b', 'c', 'd']);
  const once = orderSerialCases(cases, 'shuffle', 20261121).map((item) => item.name);
  const twice = orderSerialCases(cases, 'shuffle', 20261121).map((item) => item.name);
  assert.deepEqual(once, twice);
  assert.equal(once.length, 4);
  assert.deepEqual([...once].sort(), ['a', 'b', 'c', 'd']);
});

test('KVS headroom warns above 90 percent and fails only past the cap', () => {
  const cap = { reads: 1000, writes: 1000 };
  // 90% exactly is the boundary the warning does not cross.
  assert.equal(KVS_HEADROOM_WARN_RATIO, 0.9);
  assert.equal(buildHeadroomRow('exact', { reads: 900, writes: 900 }, cap).status, 'ok');
  assert.equal(buildHeadroomRow('just-over', { reads: 901, writes: 100 }, cap).status, 'warn');
  // Equal to the cap is still inside assertWithinBudget, and it is above 90%.
  assert.equal(buildHeadroomRow('at-cap', { reads: 1000, writes: 100 }, cap).status, 'warn');
  assert.equal(buildHeadroomRow('past', { reads: 1001, writes: 100 }, cap).status, 'over');
  assert.equal(buildHeadroomRow('idle', { reads: 0, writes: 100 }, cap).status, 'idle');
  assert.equal(buildHeadroomRow('missing', null, cap).status, 'missing');

  const rows = [
    buildHeadroomRow('zeta', { reads: 901, writes: 100 }, cap),
    buildHeadroomRow('alpha', { reads: 100, writes: 100 }, cap),
  ];
  const text = formatHeadroomReport(rows, { order: 'reverse' });
  const names = text.split('\n').filter((line) => line.startsWith('alpha') || line.startsWith('zeta'));
  assert.equal(names[0].startsWith('alpha'), true);
  assert.equal(names[1].startsWith('zeta'), true);
  assert.equal(text.includes('order: reverse'), true);
  assert.deepEqual(headroomWarnings(rows).map((line) => line.includes('zeta')), [true]);
  assert.deepEqual(headroomFailures(rows), []);
  assert.equal(headroomFailures([buildHeadroomRow('past', { reads: 1001, writes: 100 }, cap)]).length, 1);
});

testSerial('lead loop plans a goal into a DAG and runs parallel waves', async () => {
  const world = await createWorld({ llm: { mode: 'script', reply: dagReply } });
  try {
    const planned = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: DAG_GOAL,
      steps: [
        { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
        { title: 'Check capture links', workerType: 'check-deps', input: { issueKey: 'PAY-1' }, dependsOn: [] },
        { title: 'Draft the refund spec', workerType: 'draft-spec', input: 'idempotent on the payment id', dependsOn: [0, 1] },
      ],
    });
    assert.equal(planned.ok, true);
    assert.equal(planned.status, 'planning');
    assert.equal(planned.steps.length, 3);
    assert.deepEqual(planned.steps[2].dependsOn, [0, 1]);
    for (const step of planned.steps) {
      assert.equal(typeof step.skill, 'string');
      assert.equal(typeof step.brief.objective, 'string');
      assert.ok(step.brief.objective.includes(DAG_GOAL));
      assert.ok(step.brief.budget.maxOutputBytes <= 2048);
      assert.equal(step.brief.budget.maxRepairAttempts, 1);
    }
    assert.ok(planned.steps[0].brief.allowedTools.includes('searchIssues'));
    assert.ok(planned.steps[1].brief.allowedTools.includes('getIssueLinks'));
    assert.equal(world.jira.mutations.length, 0);

    const dispatched = await world.invoke('dispatch-run', { runId: planned.runId });
    assert.equal(dispatched.ok, true);
    await world.drainEffects();

    const afterDispatch = await world.store.listSteps(planned.runId);
    const byTitle = Object.fromEntries(afterDispatch.map((step) => [step.title, step]));
    assert.equal(byTitle['Research refunds'].status, 'queued');
    assert.equal(byTitle['Check capture links'].status, 'queued');
    assert.equal(byTitle['Draft the refund spec'].status, 'waiting');
    const readyIds = world.bus.peek('step-queue').map((event) => event.body.stepId);
    assert.equal(readyIds.length, 2);
    assert.ok(readyIds.includes(byTitle['Research refunds'].stepId));
    assert.ok(readyIds.includes(byTitle['Check capture links'].stepId));
    assert.equal(readyIds.includes(byTitle['Draft the refund spec'].stepId), false);

    await world.drain();
    const finished = await world.store.getRun(planned.runId);
    assert.equal(finished.status, 'done');
    const steps = await world.store.listSteps(planned.runId);
    const work = steps.filter((step) => step.workerType !== 'summarize');
    assert.equal(work.length, 5);
    assert.ok(work.every((step) => step.status === 'done'));
    const wave2 = work.filter((step) => step.wave === 2);
    assert.equal(wave2.length, 2);
    for (const step of wave2) {
      assert.deepEqual(step.dependsOn, [0, 1, 2]);
      assert.equal(typeof step.brief.objective, 'string');
      assert.ok(step.skill === 'test-plan' || step.skill === 'risk-review');
    }
    const events = await world.store.listEventsByRun(planned.runId);
    const wave2Started = events.find((event) => event.kind === 'wave_started' && event.detail?.wave === 2);
    assert.ok(wave2Started);
    const wave1Succeeded = events.filter((event) =>
      event.kind === 'step.succeeded' && [0, 1, 2].includes(event.stepIdx));
    assert.equal(wave1Succeeded.length, 3);
    assert.ok(wave1Succeeded.every((event) => event.seq < wave2Started.seq));

    const research = work.find((step) => step.title === 'Research refunds');
    assert.equal(research.output.generator, 'llm');
    assert.ok(research.output.summary.includes('idempotent'));
    assert.match(JSON.stringify(research.output.findings), new RegExp(FULL_OUTPUT_MARKER));
    assert.equal(research.output.confluence, 'client');
    assert.ok(research.output.pageCount >= 1);
    assert.ok(world.confluence.calls.some((call) => /type\s*=\s*page/i.test(call.cql)));
    assert.ok(world.confluence.calls.some((call) => /text\s*~/i.test(call.cql)));

    // The marker is a finding, not the summary. The lead and wave 2 see the
    // digest. A prompt or a follow-up comment that contains the marker is
    // the full output leaking past the digest.
    for (const call of world.llm.calls) {
      assert.equal(call.system.includes(FULL_OUTPUT_MARKER), false);
      assert.equal(
        call.user.includes(FULL_OUTPUT_MARKER),
        false,
        `full output leaked into a prompt: ${call.user.slice(0, 120)}`,
      );
    }
    for (const step of wave2) {
      assert.equal(typeof step.input.waveDigest, 'string');
      assert.ok(Buffer.byteLength(step.input.waveDigest, 'utf8') <= DIGEST_BYTE_BUDGET);
      assert.equal(JSON.stringify(step.input).includes(FULL_OUTPUT_MARKER), false);
      assert.ok(Array.isArray(step.dependencyContext));
      assert.ok(step.dependencyContext.length > 0);
      assert.ok(step.dependencyContext.every((entry) => entry.digest === true));
      assert.equal(JSON.stringify(step.dependencyContext).includes(FULL_OUTPUT_MARKER), false);
      const onChild = world.jira.mutationsOf('comment')
        .filter((comment) => comment.issueKey === step.childIssueKey);
      assert.equal(onChild.length, 1);
      assert.equal(onChild[0].bodyText.includes(FULL_OUTPUT_MARKER), false);
    }
    const leadDecisions = events.filter((event) => event.kind === 'lead_decision');
    assert.equal(leadDecisions.length, 2);
    assert.equal(leadDecisions[0].detail.wave, 1);
    assert.equal(leadDecisions[0].detail.action, 'spawn');
    assert.equal(leadDecisions[0].detail.generator, 'llm');
    assert.equal(typeof leadDecisions[0].detail.model, 'string');
    assert.equal(leadDecisions[1].detail.wave, 2);
    assert.equal(leadDecisions[1].detail.action, 'stop');
    assert.equal(leadDecisions[1].detail.generator, 'llm');
    assert.equal(finished.ledger.lastDecision.action, 'stop');
    assert.equal(finished.ledger.lastDecision.generator, 'llm');
    assertOneChildPerWorkStep(world, steps);
    assertCommentLedger(world, DEMO_KEYS.refundsEpic, { memory: 1, waves: 2 });
    await assertChildEffectsOnce(world, planned.runId, steps, DEMO_KEYS.refundsEpic);
    const researchComment = world.jira.mutationsOf('comment')
      .find((comment) => comment.issueKey === research.childIssueKey);
    assert.match(researchComment.bodyText, new RegExp(FULL_OUTPUT_MARKER));
    assertWithinBudget(world.sdk, 'dag-waves');
  } finally {
    await world.close();
  }
});

testSerial('stuck step is recovered by the watchdog when the fake clock passes the deadline', async () => {
  const world = await createWorld({ env: { CONDUCTOR_DEMO_STUCK_STEP: 'true' } });
  try {
    await markActive({ now: world.clock.now, kvs: world.sdk.kvs });
    const onTick = await shouldScan({ now: world.clock.now, kvs: world.sdk.kvs });
    assert.equal(onTick.scan, true);
    world.clock.advance(6 * 60 * 1000);
    const offTick = await shouldScan({ now: world.clock.now, kvs: world.sdk.kvs });
    assert.equal(offTick.reason, 'off-tick');
    assert.equal(offTick.scan, false);

    const planned = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
      ],
    });
    await world.invoke('dispatch-run', { runId: planned.runId });
    await world.drainEffects();
    const hung = await world.drain();
    assert.equal(hung[0].status, 'demo-hang');
    const running = (await world.store.listSteps(planned.runId))[0];
    assert.equal(running.status, 'running');
    assert.equal(running.attempt, 0);

    const tooSoon = await world.watchdog.run();
    assert.equal(tooSoon.retriedSteps.length, 0);

    world.clock.advance(STEP_DEADLINE_MS + 1000);
    // The production trigger scans only on the 15-minute tick while the gate
    // is active. The retry below is the same instant that trigger would run.
    const gate = await shouldScan({ now: world.clock.now, kvs: world.sdk.kvs });
    assert.equal(gate.scan, true);
    assert.equal(gate.reason, 'active');
    const pass = await world.watchdog.run();
    assert.equal(pass.retriedSteps.length, 1);
    assert.equal(pass.retriedSteps[0].attempt, 1);

    await world.drain();
    const finished = await world.store.getRun(planned.runId);
    assert.equal(finished.status, 'done');
    const steps = await world.store.listSteps(planned.runId);
    const step = steps.find((item) => item.workerType === 'research');
    assert.equal(step.status, 'done');
    assert.equal(step.attempt, 1);
    assert.equal(step.output.generator, 'fallback');
    const events = await world.store.listEventsByRun(planned.runId);
    const retried = events.find((event) => event.kind === 'step.retried');
    assert.ok(retried);
    assert.equal(retried.detail.attempt, 1);
    assert.equal(retried.stepId, step.stepId);
    assertOneChildPerWorkStep(world, steps);
    await assertChildEffectsOnce(world, planned.runId, steps, DEMO_KEYS.refundsEpic);
    assertCommentLedger(world, DEMO_KEYS.refundsEpic, { memory: 1, waves: 1 });
    assertWithinBudget(world.sdk, 'watchdog');
  } finally {
    await world.close();
  }
});

testSerial('human approval pauses the run and a reply resumes it', async () => {
  const world = await createWorld({ llm: { mode: 'script', reply: approvalReply } });
  try {
    const planned = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
      ],
    });
    await world.invoke('dispatch-run', { runId: planned.runId });
    await world.drain();
    const paused = await world.store.getRun(planned.runId);
    assert.equal(paused.status, 'awaiting-review');
    assert.equal(paused.ledger.lastDecision.action, 'ask');
    assert.equal(paused.ledger.lastDecision.generator, 'fallback');
    assert.ok(paused.ledger.lastDecision.suggestions.some((item) => item.workerType === 'check-deps'));

    world.clock.advance(STEP_DEADLINE_MS + 1000);
    const skipped = await world.watchdog.run();
    assert.equal(skipped.retriedSteps.length, 0);
    assert.equal((await world.store.getRun(planned.runId)).status, 'awaiting-review');

    const resumed = await childIssueUpdated({
      issue: { key: DEMO_KEYS.refundsEpic },
      eventType: 'avi:jira:commented:issue',
      comment: {
        body: 'conductor continue',
        author: { accountId: 'manager-1' },
      },
    }, {
      listRunsByEpic: (key, query) => world.store.listRunsByEpic(key, query),
      leadDependencies: world.runtime,
    });
    assert.equal(resumed.status, 'resumed');
    assert.equal(resumed.action, 'continue');

    await world.drain();
    const finished = await world.store.getRun(planned.runId);
    assert.equal(finished.status, 'done');
    const steps = await world.store.listSteps(planned.runId);
    const followUp = steps.find((step) => step.wave === 2 && step.workerType === 'check-deps');
    assert.ok(followUp);
    assert.equal(followUp.status, 'done');
    assert.equal(typeof followUp.input.waveDigest, 'string');
    assert.ok(Buffer.byteLength(followUp.input.waveDigest, 'utf8') <= DIGEST_BYTE_BUDGET);
    assert.equal(JSON.stringify(followUp.input).includes(FULL_OUTPUT_MARKER), false);
    assert.ok(followUp.dependencyContext.every((entry) => entry.digest === true));
    assert.equal(JSON.stringify(followUp.dependencyContext).includes(FULL_OUTPUT_MARKER), false);
    const research = steps.find((step) => step.workerType === 'research' && step.wave !== 2);
    assert.match(JSON.stringify(research.output.findings), new RegExp(FULL_OUTPUT_MARKER));
    for (const call of world.llm.calls) {
      assert.equal(call.user.includes(FULL_OUTPUT_MARKER), false);
      assert.equal(call.system.includes(FULL_OUTPUT_MARKER), false);
    }
    const events = await world.store.listEventsByRun(planned.runId);
    const human = events.filter((event) =>
      event.kind === 'lead_decision' && event.detail?.generator === 'human');
    assert.equal(human.length, 1);
    assert.equal(human[0].detail.action, 'continue');
    assert.equal(human[0].detail.requested, 'continue');
    assert.equal(human[0].detail.via, 'comment');
    assert.equal(human[0].detail.actor, 'manager-1');
    assertOneChildPerWorkStep(world, steps);
    assertCommentLedger(world, DEMO_KEYS.refundsEpic, { memory: 1, waves: 2 });
    await assertChildEffectsOnce(world, planned.runId, steps, DEMO_KEYS.refundsEpic);
    assertWithinBudget(world.sdk, 'approval');
  } finally {
    await world.close();
  }
});

testSerial('an accepted lesson changes the next plan', async () => {
  const world = await createWorld({ failSearch: true });
  try {
    const first = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Research billing access', workerType: 'research', input: 'billing', dependsOn: [] },
        { title: 'Draft the refund spec', workerType: 'draft-spec', input: 'refunds', dependsOn: [0] },
      ],
    });
    assert.equal(first.usedLessons.length, 0);
    assert.equal(first.steps[0].workerType, 'research');
    await world.invoke('dispatch-run', { runId: first.runId });
    await world.drain();
    const blocked = await world.store.getRun(first.runId);
    assert.equal(blocked.status, 'blocked');
    // The child issues exist. The failed worker must not have commented,
    // transitioned, or posted a wave report before the lesson was accepted.
    assert.equal(world.jira.mutationsOf('createIssue').length, 2);
    assert.equal(world.jira.mutationsOf('comment').length, 0);
    assert.equal(world.jira.mutationsOf('transition').length, 0);

    const proposed = await listLessons({ projectKey: DEMO_KEYS.projectKey }, { store: world.store });
    assert.equal(proposed.length, 1);
    assert.equal(proposed[0].rawStatus, 'proposed');
    assert.match(proposed[0].cause, /missing access to billing-api/);

    const again = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: 'Ship the payment refunds API',
      steps: [
        { title: 'Research billing access', workerType: 'research', input: 'billing', dependsOn: [] },
        { title: 'Draft the refund spec', workerType: 'draft-spec', input: 'refunds', dependsOn: [0] },
      ],
    });
    assert.equal(again.steps[0].workerType, 'research');
    assert.equal(again.usedLessons.length, 0);

    const accepted = await acceptLesson(
      { projectKey: DEMO_KEYS.projectKey, lessonId: proposed[0].lessonId },
      { store: world.store },
    );
    const changed = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: 'Ship the payment refunds API',
      steps: [
        { title: 'Research billing access', workerType: 'research', input: 'billing', dependsOn: [] },
        { title: 'Draft the refund spec', workerType: 'draft-spec', input: 'refunds', dependsOn: [0] },
      ],
    });
    assert.equal(changed.ok, true);
    assert.equal(changed.steps[0].workerType, 'check-deps');
    assert.deepEqual(changed.steps[0].dependsOn, []);
    assert.ok(changed.steps[1].dependsOn.includes(0));
    assert.deepEqual(changed.usedLessons, [accepted.lessonId]);
    assert.match(String(changed.planCard), new RegExp(accepted.lessonId));
    assert.match(String(changed.planCard), /billing-api/);
    await world.drainEffects();
    const plans = world.jira.mutationsOf('comment').filter((comment) =>
      comment.bodyText.startsWith('[Conductor plan]'));
    assert.equal(plans.length, 1);
    assert.match(plans[0].bodyText, new RegExp(accepted.lessonId));
    assert.equal(world.jira.mutationsOf('comment').length, 1);
    assert.equal(world.jira.mutationsOf('createIssue').length, 2);
    assert.equal(world.jira.mutationsOf('transition').length, 0);
    assertWithinBudget(world.sdk, 'lessons');
  } finally {
    await world.close();
  }
});

testSerial('flight recorder replays without writes and a fork reruns only downstream steps', async () => {
  const world = await createWorld();
  try {
    const planned = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
        { title: 'Draft the refund spec', workerType: 'draft-spec', input: 'idempotent', dependsOn: [0] },
      ],
    });
    await world.invoke('dispatch-run', { runId: planned.runId });
    await world.drain();
    assert.equal((await world.store.getRun(planned.runId)).status, 'done');
    const createsBefore = world.jira.mutationsOf('createIssue').length;
    const writesBefore = world.jira.calls.filter((call) => call.method !== 'GET').length;
    assertCommentLedger(world, DEMO_KEYS.refundsEpic, { memory: 1, waves: 1 });

    const replay = await world.invoke('replay-run', { runId: planned.runId });
    assert.equal(replay.ok, true);
    assert.equal(replay.dryRun, true);
    assert.equal(replay.duplicateWrites, 0);
    assert.equal(jiraWriteCount(world), writesBefore);
    assert.ok(replay.effects.length > 0);
    assert.ok(replay.effects.every((effect) => effect.verdict === 'already-applied-skipped'));
    assert.ok(replay.effects.every((effect) => effect.wouldWrite === false));

    const forked = await world.invoke('fork-run', { runId: planned.runId, stepIdx: 0 });
    assert.equal(forked.ok, true);
    assert.notEqual(forked.runId, planned.runId);
    await world.drain();
    const forkedSteps = await world.store.listSteps(forked.runId);
    const copied = forkedSteps.find((step) => step.idx === 0);
    const rerun = forkedSteps.find((step) => step.idx === 1);
    assert.equal(copied.status, 'done');
    assert.equal(copied.childIssueKey, (await world.store.listSteps(planned.runId)).find((step) => step.idx === 0).childIssueKey);
    assert.equal(rerun.status, 'done');
    assert.notEqual(rerun.childIssueKey, copied.childIssueKey);
    const createsAfter = world.jira.mutationsOf('createIssue').length;
    assert.equal(createsAfter - createsBefore, 1);
    const originalResearchKey = copied.childIssueKey;
    const commentsOnOriginal = world.jira.mutationsOf('comment')
      .filter((comment) => comment.issueKey === originalResearchKey);
    assert.equal(commentsOnOriginal.length, 1);
    const commentsOnRerun = world.jira.mutationsOf('comment')
      .filter((comment) => comment.issueKey === rerun.childIssueKey);
    assert.equal(commentsOnRerun.length, 1);
    assertWithinBudget(world.sdk, 'recorder');
  } finally {
    await world.close();
  }
});

testSerial('another agent calls Conductor as a tool and a second dispatch does not enqueue again', async () => {
  const world = await createWorld();
  try {
    const handed = await world.handoff({
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      stepsJson: defaultStepsJson(GOAL),
    });
    assert.equal(handed.ok, true);
    assert.equal(handed.awaitingConfirmation, true);
    assert.equal(handed.status, 'planning');
    assert.deepEqual(handed.calls.map((call) => call.tool), [
      'recall-memory',
      'plan-split',
    ]);
    assert.ok(handed.calls.every((call) => call.result.ok === true));
    assert.equal(world.jira.mutationsOf('createIssue').length, 0);
    const confirmed = await world.invoke('dispatch-run', { runId: handed.runId });
    assert.equal(confirmed.ok, true, confirmed.error);
    assert.equal(confirmed.status, 'running');
    const recalled = handed.calls[0].result;
    assert.ok(Array.isArray(recalled.skillIndex));
    assert.ok(recalled.skillIndex.some((skill) => skill.name === 'research' && skill.description));
    assert.equal('body' in (recalled.skillIndex[0] ?? {}), false);

    await world.drain();
    const finished = await world.store.getRun(handed.runId);
    assert.equal(finished.status, 'done');
    const steps = await world.store.listSteps(handed.runId);
    assert.ok(steps.some((step) => step.workerType === 'research' && step.skill === 'research'));
    assert.ok(steps.some((step) => step.workerType === 'draft-spec' && step.dependsOn.includes(0)));
    const creates = world.jira.mutationsOf('createIssue').length;
    const comments = world.jira.mutationsOf('comment').length;
    const writes = jiraWriteCount(world);
    assertCommentLedger(world, DEMO_KEYS.refundsEpic, { memory: 1, waves: 1 });
    assertOneChildPerWorkStep(world, steps);

    const again = await world.invoke('dispatch-run', { runId: handed.runId });
    assert.equal(again.ok, true);
    assert.equal(again.status, 'done');
    assert.equal(world.bus.ready('step-queue'), 0);
    assert.equal(world.bus.ready('effect-queue'), 0);
    assert.equal(world.jira.mutationsOf('createIssue').length, creates);
    assert.equal(world.jira.mutationsOf('comment').length, comments);
    assert.equal(jiraWriteCount(world), writes);
    assertWithinBudget(world.sdk, 'handoff');
  } finally {
    await world.close();
  }
});

testSerial('a thrown model call falls back to the worker template', async () => {
  const world = await createWorld({ llm: { mode: 'throw', error: 'Forge LLM quota exceeded' } });
  try {
    const planned = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
      ],
    });
    await world.invoke('dispatch-run', { runId: planned.runId });
    await world.drain();
    const step = (await world.store.listSteps(planned.runId)).find((item) => item.workerType === 'research');
    assert.equal(step.status, 'done');
    assert.equal(step.output.generator, 'fallback');
    assert.equal(step.output.model, null);
    assert.match(step.output.summary, /Found \d+ related issue/);
    assert.match(step.output.summary, /Refunds runbook/);
    assert.equal(step.output.confluence, 'client');
    assert.ok(world.llm.calls.length >= 1);
    assert.equal((await world.store.getRun(planned.runId)).status, 'done');
    const steps = await world.store.listSteps(planned.runId);
    assertOneChildPerWorkStep(world, steps);
    assertCommentLedger(world, DEMO_KEYS.refundsEpic, { memory: 1, waves: 1 });
    await assertChildEffectsOnce(world, planned.runId, steps, DEMO_KEYS.refundsEpic);
    assertWithinBudget(world.sdk, 'llm-throw');
  } finally {
    await world.close();
  }
});

testSerial('an empty model message falls back to the worker template', async () => {
  const world = await createWorld({ llm: { mode: 'empty' } });
  try {
    const planned = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
      ],
    });
    await world.invoke('dispatch-run', { runId: planned.runId });
    await world.drain();
    const steps = await world.store.listSteps(planned.runId);
    const step = steps.find((item) => item.workerType === 'research');
    assert.equal(step.status, 'done');
    assert.equal(step.output.generator, 'fallback');
    assert.match(step.output.summary, /Found \d+ related issue/);
    assert.equal((await world.store.getRun(planned.runId)).status, 'done');
    assert.ok(world.llm.calls.length >= 1);
    assertOneChildPerWorkStep(world, steps);
    assertCommentLedger(world, DEMO_KEYS.refundsEpic, { memory: 1, waves: 1 });
    assertWithinBudget(world.sdk, 'llm-empty');
  } finally {
    await world.close();
  }
});

testSerial('model prose that is not JSON falls back to the worker template', async () => {
  const world = await createWorld({ llm: { mode: 'malformed' } });
  try {
    const planned = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
      ],
    });
    await world.invoke('dispatch-run', { runId: planned.runId });
    await world.drain();
    const steps = await world.store.listSteps(planned.runId);
    const step = steps.find((item) => item.workerType === 'research');
    assert.equal(step.status, 'done');
    assert.equal(step.output.generator, 'fallback');
    assert.match(step.output.summary, /Found \d+ related issue/);
    assert.equal((await world.store.getRun(planned.runId)).status, 'done');
    assert.equal(world.jira.mutationsOf('transition').length, 0);
    assert.equal(
      world.jira.mutationsOf('createIssue').some((create) => String(create.summary).includes('transition every issue')),
      false,
    );
    assertOneChildPerWorkStep(world, steps);
    assertCommentLedger(world, DEMO_KEYS.refundsEpic, { memory: 1, waves: 1 });
    assertWithinBudget(world.sdk, 'llm-malformed');
  } finally {
    await world.close();
  }
});

testSerial('prompt injection in ticket text does not cause extra effects', async () => {
  const world = await createWorld({
    poison: true,
    llm: { mode: 'script', reply: injectionReply },
  });
  try {
    const planned = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
      ],
    });
    await world.invoke('dispatch-run', { runId: planned.runId });
    await world.drain();
    assert.equal((await world.store.getRun(planned.runId)).status, 'done');
    const creates = world.jira.mutationsOf('createIssue');
    assert.equal(creates.length, 1);
    assert.equal(creates[0].summary, 'Research refunds');
    assert.equal(
      creates.some((create) => String(create.summary).includes('Smuggled extra issue')),
      false,
    );
    const childComments = world.jira.mutationsOf('comment')
      .filter((comment) => comment.issueKey === creates[0].issueKey);
    assert.equal(childComments.length, 1);
    assert.match(childComments[0].bodyText, new RegExp(INJECTION_TOKEN));
    const storedEffects = await world.store.listEffectsByRun(planned.runId);
    assert.equal(storedEffects.some((effect) => effect.kind === 'transition'), false);
    for (const call of world.llm.calls) {
      assert.equal(call.system.includes(INJECTION_TOKEN), false);
      assert.equal(call.system.includes('Smuggled extra issue'), false);
      assert.equal(outsideUntrusted(call.user).includes(INJECTION_TOKEN), false);
      assert.equal(outsideUntrusted(call.user).includes('Smuggled extra issue'), false);
      assert.equal(outsideUntrusted(call.user).includes('example.com'), false);
      const tags = untrustedTagCounts(call.user);
      assert.equal(tags.open, tags.close);
      assert.ok(tags.open >= 1);
    }
    assertCommentLedger(world, DEMO_KEYS.refundsEpic, { memory: 1, waves: 1 });
    assert.equal(world.confluence.calls.every((call) => !/^https?:/i.test(call.cql)), true);
    assert.equal(world.confluence.calls.every((call) => !/example\.com/i.test(call.cql)), true);
    assertWithinBudget(world.sdk, 'injection');
  } finally {
    await world.close();
  }
});

testSerial('duplicate dispatch and a redelivered queue message do not write again', async () => {
  const world = await createWorld();
  try {
    const planned = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
        { title: 'Draft the refund spec', workerType: 'draft-spec', input: 'idempotent on the payment id', dependsOn: [0] },
      ],
    });
    assert.equal(planned.ok, true);
    assert.equal(planned.steps.length, 2);

    // Two dispatch calls in one turn. The run lock lets the first leave
    // `planning`. The second must observe that and push nothing.
    const [firstDispatch, secondDispatch] = await Promise.all([
      world.invoke('dispatch-run', { runId: planned.runId }),
      world.invoke('dispatch-run', { runId: planned.runId }),
    ]);
    assert.equal(firstDispatch.ok, true);
    assert.equal(secondDispatch.ok, true);
    assert.equal(firstDispatch.runId, planned.runId);
    assert.equal(secondDispatch.runId, planned.runId);
    assert.equal(firstDispatch.status, 'running');
    assert.equal(secondDispatch.status, 'running');
    assert.equal(world.bus.ready('effect-queue'), 2);
    assert.equal(world.bus.ready('step-queue'), 1);
    const held = (await world.store.listSteps(planned.runId))
      .find((step) => step.title === 'Draft the refund spec');
    assert.equal(held.status, 'waiting');
    assert.equal(world.jira.mutationsOf('createIssue').length, 0);

    // Three deliveries of one createIssue message, before it is dequeued.
    // The in-process lock and the status compare-and-set must call Jira once.
    const firstEffect = world.bus.peek('effect-queue')[0];
    await Promise.all([
      effectApplierHandler(firstEffect),
      effectApplierHandler(firstEffect),
      effectApplierHandler(firstEffect),
    ]);
    assert.equal(world.jira.mutationsOf('createIssue').length, 1);

    // The originals are still on the bus. Push each one again, which is the
    // at-least-once redelivery the consumer has to ignore once applied and
    // apply once while it is still pending.
    for (const event of world.bus.peek('effect-queue')) {
      await new world.bus.Queue({ key: 'effect-queue' }).push({ body: event.body });
    }
    for (const event of world.bus.peek('step-queue')) {
      await new world.bus.Queue({ key: 'step-queue' }).push({ body: event.body });
    }
    assert.equal(world.bus.ready('effect-queue'), 4);
    assert.equal(world.bus.ready('step-queue'), 2);

    await world.drain();
    const finished = await world.store.getRun(planned.runId);
    assert.equal(finished.status, 'done');
    const steps = await world.store.listSteps(planned.runId);
    assertOneChildPerWorkStep(world, steps);
    assertCommentLedger(world, DEMO_KEYS.refundsEpic, { memory: 1, waves: 1 });
    await assertChildEffectsOnce(world, planned.runId, steps, DEMO_KEYS.refundsEpic);

    const research = steps.find((step) => step.workerType === 'research');
    const duplicateEnqueue = await world.runtime.enqueueEffect({
      runId: planned.runId,
      stepId: research.stepId,
      kind: 'createIssue',
      payload: {
        projectKey: DEMO_KEYS.projectKey,
        parentKey: DEMO_KEYS.refundsEpic,
        summary: 'Research refunds',
        description: 'A second body must not create a second issue.',
        issueType: 'Sub-task',
      },
      discriminator: 'child-issue',
    });
    assert.equal(duplicateEnqueue.created, false);
    assert.equal(world.bus.ready('effect-queue'), 0);
    assert.equal(world.bus.ready('step-queue'), 0);
    assert.equal(world.jira.mutationsOf('createIssue').length, 2);

    const appliedBefore = await world.store.listEffectsByRun(planned.runId);
    const journalBefore = (await world.store.listEventsByRun(planned.runId))
      .filter((event) => event.kind === 'effect.written' && event.detail?.phase === 'applied')
      .length;
    const writesBefore = jiraWriteCount(world);
    const commentsBefore = world.jira.mutationsOf('comment').length;
    const usageBefore = world.sdk.usage();

    for (const effect of appliedBefore) {
      await new world.bus.Queue({ key: 'effect-queue' }).push({
        body: { requestKey: effect.requestKey },
      });
    }
    for (const step of steps) {
      if (step.status !== 'done') {
        continue;
      }
      await new world.bus.Queue({ key: 'step-queue' }).push({
        body: { runId: planned.runId, stepId: step.stepId, attempt: step.attempt },
      });
    }
    await world.drain();

    const thirdDispatch = await world.invoke('dispatch-run', { runId: planned.runId });
    assert.equal(thirdDispatch.ok, true);
    assert.equal(thirdDispatch.status, 'done');
    await world.drain();

    assert.equal(jiraWriteCount(world), writesBefore);
    assert.equal(world.jira.mutationsOf('createIssue').length, 2);
    assert.equal(world.jira.mutationsOf('comment').length, commentsBefore);
    const usageAfter = world.sdk.usage();
    const writeDelta = usageAfter.writes - usageBefore.writes;
    const readDelta = usageAfter.reads - usageBefore.reads;
    if (process.env.SIM_BUDGET_DEBUG) {
      console.log(`[kvs] duplicate-redelivery reads=${readDelta} writes=${writeDelta}`);
    }
    assert.equal(writeDelta, 0, `redelivery wrote ${writeDelta} KVS bytes`);
    assert.ok(readDelta > 0, 'redelivery should re-read the effect rows');
    // Remeasured 2026-11-09: 31,327 read bytes, 0 write bytes. The same
    // total in source order, reverse order, and a seeded shuffle. The cap
    // stays 36,000 (the earlier 31,174 measurement plus about 15%).
    assert.ok(readDelta <= 36_000, `redelivery read ${readDelta} KVS bytes`);

    const appliedAfter = await world.store.listEffectsByRun(planned.runId);
    assert.equal(appliedAfter.length, appliedBefore.length);
    for (const before of appliedBefore) {
      const after = appliedAfter.find((effect) => effect.requestKey === before.requestKey);
      assert.equal(after.status, 'applied');
      assert.equal(after.tries, before.tries);
      assert.deepEqual(after.result, before.result);
    }
    const journalAfter = (await world.store.listEventsByRun(planned.runId))
      .filter((event) => event.kind === 'effect.written' && event.detail?.phase === 'applied')
      .length;
    assert.equal(journalAfter, journalBefore);
    assertWithinBudget(world.sdk, 'duplicate-dispatch');
  } finally {
    await world.close();
  }
});

/**
 * Checklist skill whose schema repair can fill a missing summary and cannot
 * fix a non-numeric confidence or a notes value that is not an array.
 * One model call. The repair itself is mechanical.
 *
 * @param {{system: string, user: string}} prompt
 * @returns {string}
 */
function schemaViolationReply({ system, user }) {
  if (system.includes('Ticket Conductor sub-agent') && user.includes('Skill: risk-review')) {
    return JSON.stringify({
      notes: 'not-an-array',
      confidence: 'high',
    });
  }
  throw new Error(`schema script has no reply for this prompt: ${user.slice(0, 80)}`);
}

testSerial('a dependency cycle is rejected and a waiting step is not retried', async () => {
  const world = await createWorld();
  try {
    const beforeReject = world.sdk.usage();
    const rejected = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [1] },
        { title: 'Draft the refund spec', workerType: 'draft-spec', input: 'idempotent', dependsOn: [0] },
      ],
    });
    const afterReject = world.sdk.usage();
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'VALIDATION');
    assert.match(rejected.error, /plan has a dependency cycle: 0 -> 1 -> 0/);
    assert.equal(afterReject.writes - beforeReject.writes, 0, 'a rejected plan must not write KVS');
    assert.equal(afterReject.reads - beforeReject.reads, 0, 'a rejected plan must not read KVS');
    assert.equal(world.jira.calls.length, 0);
    assert.equal(world.jira.mutations.length, 0);
    assert.equal(world.bus.size('effect-queue'), 0);
    assert.equal(world.bus.size('step-queue'), 0);
    assert.equal((await world.store.listRunsByEpic(DEMO_KEYS.refundsEpic)).length, 0);

    const planned = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
        { title: 'Draft the refund spec', workerType: 'draft-spec', input: 'idempotent on the payment id', dependsOn: [0] },
      ],
    });
    assert.equal(planned.ok, true);
    assert.equal(planned.steps[1].brief.upstream, undefined);
    assert.equal(String(planned.steps[1].brief.objective).includes('Upstream:'), false);
    assert.deepEqual(planned.steps[1].dependsOn, [0]);

    await world.invoke('dispatch-run', { runId: planned.runId });
    await world.drainEffects();
    const held = await world.store.listSteps(planned.runId);
    const researchHeld = held.find((step) => step.title === 'Research refunds');
    const draftHeld = held.find((step) => step.title === 'Draft the refund spec');
    assert.equal(researchHeld.status, 'queued');
    assert.equal(researchHeld.attempt, 0);
    assert.equal(draftHeld.status, 'waiting');
    assert.equal(draftHeld.attempt, 0);
    assert.equal(typeof draftHeld.childIssueKey, 'string');
    const childBefore = draftHeld.childIssueKey;
    assert.deepEqual(
      world.bus.peek('step-queue').map((event) => event.body.stepId),
      [researchHeld.stepId],
    );
    assert.equal(world.jira.mutationsOf('createIssue').length, 2);
    assert.equal(world.jira.mutationsOf('comment').length, 0);
    const writesBeforeWatchdog = jiraWriteCount(world);

    world.clock.advance(STUCK_QUEUED_MS + 1000);
    const pass = await world.watchdog.run();
    assert.equal(pass.scannedSteps, 1);
    assert.equal(pass.retriedSteps.length, 1);
    assert.equal(pass.retriedSteps[0].stepId, researchHeld.stepId);
    assert.equal(pass.retriedSteps[0].attempt, 1);
    assert.equal(pass.failedSteps.length, 0);
    const touched = [...pass.retriedSteps, ...pass.failedSteps, ...pass.skippedSteps];
    assert.equal(touched.some((item) => item.stepId === draftHeld.stepId), false);
    const stillWaiting = await world.store.getStep(draftHeld.stepId);
    assert.equal(stillWaiting.status, 'waiting');
    assert.equal(stillWaiting.attempt, 0);
    assert.equal(stillWaiting.childIssueKey, childBefore);
    assert.equal(jiraWriteCount(world), writesBeforeWatchdog);
    assert.equal(world.jira.mutationsOf('createIssue').length, 2);
    assert.equal(world.bus.ready('effect-queue'), 0);
    const queuedAfterWatchdog = world.bus.peek('step-queue').map((event) => event.body);
    assert.equal(queuedAfterWatchdog.some((body) => body.stepId === draftHeld.stepId), false);
    assert.deepEqual(
      queuedAfterWatchdog
        .filter((body) => body.stepId === researchHeld.stepId)
        .map((body) => body.attempt)
        .sort((left, right) => left - right),
      [0, 1],
    );
    const journalAtWatchdog = await world.store.listEventsByRun(planned.runId);
    const retried = journalAtWatchdog.filter((event) => event.kind === 'step.retried');
    assert.equal(retried.length, 1);
    assert.equal(retried[0].stepId, researchHeld.stepId);
    assert.equal(retried[0].detail.attempt, 1);
    assert.equal(retried[0].detail.workerType, 'research');
    assert.equal(
      journalAtWatchdog.some((event) => event.kind === 'step.retried' && event.stepId === draftHeld.stepId),
      false,
    );

    await world.drain();
    const finished = await world.store.getRun(planned.runId);
    assert.equal(finished.status, 'done');
    const steps = await world.store.listSteps(planned.runId);
    const research = steps.find((step) => step.title === 'Research refunds');
    const draft = steps.find((step) => step.title === 'Draft the refund spec');
    assert.equal(research.status, 'done');
    assert.equal(research.attempt, 1);
    assert.equal(draft.status, 'done');
    assert.equal(draft.attempt, 0);
    assert.equal(draft.childIssueKey, childBefore);
    assert.equal(draft.dependencyContext.length, 1);
    assert.equal(draft.dependencyContext[0].idx, 0);
    assert.equal(draft.dependencyContext[0].title, research.title);
    assert.equal(draft.dependencyContext[0].workerType, 'research');
    assert.equal(draft.dependencyContext[0].digest, undefined);
    assert.equal(draft.dependencyContext[0].output.summary, research.output.summary);
    assert.equal(
      draft.dependencyContext[0].output.findings.length,
      research.output.findings.length,
    );
    assert.ok(research.output.summary.length > 0);
    const quote = upstreamQuote(draft.dependencyContext[0]);
    assert.equal(draft.brief.upstream, quote);
    assert.equal(draft.brief.dependsOn.length, 1);
    assert.equal(draft.brief.dependsOn[0], 0);
    assert.ok(draft.brief.objective.includes(`Upstream: ${quote}`));
    assert.ok(quote.includes(research.output.summary.replace(/\s+/g, ' ').trim().slice(0, 40)));

    const events = await world.store.listEventsByRun(planned.runId);
    const researchDone = events.find((event) =>
      event.kind === 'step.succeeded' && event.stepId === research.stepId);
    const draftDone = events.find((event) =>
      event.kind === 'step.succeeded' && event.stepId === draft.stepId);
    assert.ok(researchDone);
    assert.ok(draftDone);
    assert.ok(researchDone.seq < draftDone.seq);
    const retriedAfter = events.filter((event) => event.kind === 'step.retried');
    assert.equal(retriedAfter.length, 1);
    assert.equal(retriedAfter[0].stepId, research.stepId);

    assert.equal(world.jira.mutationsOf('createIssue').length, 2);
    assertOneChildPerWorkStep(world, steps);
    assertCommentLedger(world, DEMO_KEYS.refundsEpic, { memory: 1, waves: 1 });
    await assertChildEffectsOnce(world, planned.runId, steps, DEMO_KEYS.refundsEpic);
    const effects = await world.store.listEffectsByRun(planned.runId);
    const draftCreates = effects.filter((effect) =>
      effect.stepId === draft.stepId && effect.kind === 'createIssue');
    assert.equal(draftCreates.length, 1);
    assert.equal(draftCreates[0].status, 'applied');
    assert.equal(draftCreates[0].tries, 1);
    assert.equal(draftCreates[0].result.issueKey, childBefore);
    assertWithinBudget(world.sdk, 'dependency-graph');
  } finally {
    await world.close();
  }
});

testSerial('a schema violation is repaired once and then the step is blocked', async () => {
  const world = await createWorld({ llm: { mode: 'script', reply: schemaViolationReply } });
  try {
    const planned = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Review refund risks', workerType: 'risk-review', input: 'ledger', dependsOn: [] },
      ],
    });
    assert.equal(planned.ok, true);
    assert.equal(planned.steps[0].skill, 'risk-review');
    assert.equal(planned.steps[0].brief.budget.maxRepairAttempts, 1);
    await world.invoke('dispatch-run', { runId: planned.runId });
    await world.drainEffects();
    const callsBeforeWorker = world.jira.calls.length;
    assert.equal(world.jira.mutationsOf('createIssue').length, 1);
    assert.equal(world.jira.mutationsOf('comment').length, 0);

    const results = await world.drain();
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'blocked');
    assert.equal(results[0].error.code, 'SCHEMA_INVALID');
    assert.match(results[0].error.message, /Skill "risk-review" output failed its schema after one repair/);
    assert.equal(results[0].error.message.includes('$.summary is required'), false);
    assert.deepEqual(results[0].error.details, [
      '$.notes must be an array',
      '$.confidence must be a number',
    ]);

    const step = (await world.store.listSteps(planned.runId))
      .find((item) => item.workerType === 'risk-review');
    assert.equal(step.status, 'blocked');
    assert.equal(step.attempt, 0);
    assert.equal(step.output, undefined);
    assert.equal(step.error.code, 'SCHEMA_INVALID');
    assert.deepEqual(step.error.details, results[0].error.details);
    assert.equal((await world.store.getRun(planned.runId)).status, 'blocked');

    assert.equal(world.llm.calls.length, 1);
    assert.ok(world.llm.calls[0].user.includes('Skill: risk-review'));
    assert.ok(world.llm.calls[0].user.includes('"required":["summary"]'));
    assert.equal(world.jira.calls.length, callsBeforeWorker);
    assert.equal(world.jira.mutationsOf('createIssue').length, 1);
    assert.equal(world.jira.mutationsOf('comment').length, 0);
    assert.equal(world.jira.mutationsOf('transition').length, 0);
    assert.equal(world.bus.ready('step-queue'), 0);
    assert.equal(world.bus.ready('effect-queue'), 0);

    const effects = await world.store.listEffectsByRun(planned.runId);
    const comments = effects.filter((effect) => effect.kind === 'comment');
    const creates = effects.filter((effect) => effect.kind === 'createIssue');
    assert.equal(comments.length, 0);
    assert.equal(creates.length, 1);
    assert.equal(creates[0].status, 'applied');
    assert.equal(creates[0].tries, 1);
    assert.equal(creates[0].stepId, step.stepId);

    const events = await world.store.listEventsByRun(planned.runId);
    const started = events.filter((event) => event.kind === 'step.started');
    const failed = events.filter((event) => event.kind === 'step.failed');
    assert.equal(started.length, 1);
    assert.equal(started[0].stepId, step.stepId);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].stepId, step.stepId);
    assert.equal(failed[0].detail.status, 'blocked');
    assert.equal(failed[0].detail.attempt, 0);
    assert.equal(failed[0].detail.skill, 'risk-review');
    assert.equal(failed[0].detail.error.code, 'SCHEMA_INVALID');
    assert.match(failed[0].detail.error.message, /after one repair/);
    assert.equal(failed[0].detail.error.message.includes('$.summary is required'), false);
    assert.deepEqual(failed[0].detail.error.details, [
      '$.notes must be an array',
      '$.confidence must be a number',
    ]);
    assert.equal(events.some((event) => event.kind === 'step.succeeded'), false);
    assert.equal(events.some((event) => event.kind === 'step.retried'), false);
    const appliedWrites = events.filter((event) =>
      event.kind === 'effect.written' && event.detail?.phase === 'applied');
    assert.equal(appliedWrites.length, 1);
    assert.equal(appliedWrites[0].detail.kind, 'createIssue');
    assert.equal(appliedWrites[0].stepId, step.stepId);
    assertWithinBudget(world.sdk, 'schema-repair');
  } finally {
    await world.close();
  }
});

testSerial('a tool outside the brief is refused and does not call Jira', async () => {
  const world = await createWorld();
  try {
    const planned = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        {
          title: 'Research refunds',
          workerType: 'research',
          input: { allowedTools: [] },
          dependsOn: [],
        },
      ],
    });
    assert.equal(planned.ok, true);
    assert.deepEqual(planned.steps[0].brief.allowedTools, []);
    await world.invoke('dispatch-run', { runId: planned.runId });
    await world.drainEffects();
    const callsBeforeWorker = world.jira.calls.length;
    assert.ok(callsBeforeWorker > 0);
    assert.equal(world.jira.mutationsOf('createIssue').length, 1);
    assert.equal(
      world.jira.calls.some((call) => call.pathname === '/rest/api/3/search/jql'),
      false,
    );

    const results = await world.drain();
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'blocked');
    assert.equal(results[0].error.code, 'TOOL_NOT_ALLOWED');
    assert.equal(
      results[0].error.message,
      'Tool "searchIssues" is not in this brief (allowed: none)',
    );

    const step = (await world.store.listSteps(planned.runId))
      .find((item) => item.workerType === 'research');
    assert.equal(step.status, 'blocked');
    assert.equal(step.attempt, 0);
    assert.equal(step.output, undefined);
    assert.deepEqual(step.brief.allowedTools, []);
    assert.equal(step.error.code, 'TOOL_NOT_ALLOWED');
    assert.equal(step.error.message, results[0].error.message);
    assert.equal((await world.store.getRun(planned.runId)).status, 'blocked');

    assert.equal(world.jira.calls.length, callsBeforeWorker);
    assert.equal(
      world.jira.calls.some((call) => call.pathname === '/rest/api/3/search/jql'),
      false,
    );
    assert.equal(
      world.jira.calls.some((call) => call.method === 'GET'),
      false,
    );
    assert.equal(world.confluence.calls.length, 0);
    assert.equal(world.llm.calls.length, 0);
    assert.equal(world.jira.mutationsOf('createIssue').length, 1);
    assert.equal(world.jira.mutationsOf('comment').length, 0);
    assert.equal(world.jira.mutationsOf('transition').length, 0);
    assert.equal(world.bus.ready('step-queue'), 0);
    assert.equal(world.bus.ready('effect-queue'), 0);

    const effects = await world.store.listEffectsByRun(planned.runId);
    assert.equal(effects.filter((effect) => effect.kind === 'comment').length, 0);
    const creates = effects.filter((effect) => effect.kind === 'createIssue');
    assert.equal(creates.length, 1);
    assert.equal(creates[0].status, 'applied');
    assert.equal(creates[0].tries, 1);
    assert.equal(creates[0].result.issueKey, step.childIssueKey);

    const events = await world.store.listEventsByRun(planned.runId);
    const failed = events.filter((event) => event.kind === 'step.failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].stepId, step.stepId);
    assert.equal(failed[0].detail.status, 'blocked');
    assert.equal(failed[0].detail.error.code, 'TOOL_NOT_ALLOWED');
    assert.equal(failed[0].detail.error.message, results[0].error.message);
    assert.equal(failed[0].detail.attempt, 0);
    assert.equal(events.some((event) => event.kind === 'step.succeeded'), false);
    assert.equal(events.some((event) => event.kind === 'step.retried'), false);
    const applied = events.filter((event) =>
      event.kind === 'effect.written' && event.detail?.phase === 'applied');
    assert.equal(applied.length, 1);
    assert.equal(applied[0].detail.kind, 'createIssue');
    assert.equal(applied[0].stepId, step.stepId);
    assert.equal(applied[0].detail.result.issueKey, step.childIssueKey);
    assertWithinBudget(world.sdk, 'brief-tool');
  } finally {
    await world.close();
  }
});

testSerial('blast preview lists the template writes and matches the Jira log after the run', async () => {
  const world = await createWorld();
  try {
    const epicKey = DEMO_KEYS.refundsEpic;
    assert.equal(world.jira.mutations.length, 0);
    const planned = await world.invoke('plan-split', {
      epicKey,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Research refunds', workerType: 'research', input: GOAL, dependsOn: [] },
        { title: 'Check capture links', workerType: 'check-deps', input: GOAL, dependsOn: [0] },
        { title: 'Draft the refund spec', workerType: 'draft-spec', input: GOAL, dependsOn: [1] },
      ],
    });
    assert.equal(planned.ok, true);
    assert.equal(world.jira.mutations.length, 0, 'planning the preview wrote to Jira');
    const card = planned.blastRadius;
    assert.equal(card.phase, 'preview');
    assert.equal(card.gate.insert, false);
    assert.equal(card.risk.exceeds, false);
    const certain = card.writes.filter((write) => write.certainty === 'certain');
    assert.deepEqual(
      certain.filter((write) => write.kind === 'createIssue').map((write) => write.template),
      ['child-issue', 'child-issue', 'child-issue'],
    );
    assert.deepEqual(
      certain.filter((write) => write.kind === 'comment').map((write) => write.template),
      ['research-comment', 'check-deps-comment', 'draft-spec-comment'],
    );
    assert.equal(
      card.writes.some((write) => write.template === 'memory:epic-comment' && write.certainty === 'if-done'),
      true,
    );
    assert.equal(card.writes.some((write) => write.template === 'wave-report'), false);
    assert.equal(card.omitted.some((entry) => entry.template === 'wave-report'), true);

    // Eight work steps cannot grow a ninth issue. Pure: no store, no Jira.
    const eight = previewBlastRadius({
      run: {
        runId: 'eight-step-plan',
        epicKey,
        projectKey: DEMO_KEYS.projectKey,
        goal: GOAL,
      },
      steps: Array.from({ length: 8 }, (_, idx) => ({
        stepId: `eight-${idx}`,
        idx,
        title: `Step ${idx}`,
        workerType: 'draft-spec',
        status: 'queued',
        dependsOn: [],
      })),
    });
    assert.equal(eight.gate.insert, true);
    assert.equal(eight.gate.fits, false);
    assert.equal(world.jira.mutations.length, 0);

    const dispatched = await world.invoke('dispatch-run', { runId: planned.runId });
    assert.equal(dispatched.ok, true);
    assert.equal(dispatched.status, 'running');
    assert.equal(world.jira.mutations.length, 0, 'dispatch computed the preview and wrote to Jira');
    const dispatchedKeys = dispatched.blastRadius.writes
      .filter((write) => write.kind === 'createIssue')
      .map((write) => write.requestKey)
      .sort();
    const plannedKeys = certain
      .filter((write) => write.kind === 'createIssue')
      .map((write) => write.requestKey)
      .sort();
    assert.deepEqual(dispatchedKeys, plannedKeys);
    const queued = await world.store.listEffectsByRun(planned.runId);
    const queuedCreates = queued.filter((effect) => effect.kind === 'createIssue');
    assert.deepEqual(
      queuedCreates.map((effect) => effect.requestKey).sort(),
      plannedKeys,
    );

    await world.drain();
    const finished = await world.store.getRun(planned.runId);
    assert.equal(finished.status, 'done');
    const steps = await world.store.listSteps(planned.runId);
    assertCommentLedger(world, epicKey, { memory: 1, waves: 1 });
    assertOneChildPerWorkStep(world, steps);

    /** @type {Record<string, string>} */
    const childIssueKeys = {};
    for (const step of steps) {
      if (typeof step.childIssueKey === 'string' && step.childIssueKey.length > 0) {
        childIssueKeys[step.stepId] = step.childIssueKey;
      }
    }
    const account = accountPreviewWrites(card, world.jira.mutations, {
      finished: true,
      epicKey,
      childIssueKeys,
    });
    assert.deepEqual(account.missing.map((write) => write.template), []);
    assert.deepEqual(account.extra, []);
    assert.equal(account.acknowledged.length, 1);
    assert.equal(account.acknowledged[0].template, 'wave-report');
    const predicted = card.writes.filter((write) => (
      write.certainty === 'certain' || write.certainty === 'if-done'
    ));
    assert.equal(account.paired, predicted.length);
    assert.equal(world.jira.mutations.length, predicted.length + account.acknowledged.length);

    const applied = await world.store.listEffectsByRun(planned.runId);
    const appliedKeys = new Set(
      applied.filter((effect) => effect.status === 'applied').map((effect) => effect.requestKey),
    );
    for (const write of predicted) {
      assert.equal(appliedKeys.has(write.requestKey), true, write.template);
    }
    const unpredicted = applied.filter((effect) => (
      effect.status === 'applied' && !predicted.some((write) => write.requestKey === effect.requestKey)
    ));
    assert.equal(unpredicted.length, 1);
    assert.equal(unpredicted[0].kind, 'comment');
    assert.equal(unpredicted[0].payload.issueKey, epicKey);
    assert.match(unpredicted[0].payload.bodyText, /^\[Conductor wave\]/);
    const anchor = steps
      .filter((step) => step.workerType !== 'summarize')
      .sort((left, right) => left.idx - right.idx)
      .at(-1);
    assert.equal(unpredicted[0].requestKey, plannedRequestKey({
      runId: planned.runId,
      stepId: anchor.stepId,
      kind: 'comment',
      discriminator: 'wave-report:1',
    }));

    assertWithinBudget(world.sdk, 'blast-preview');
  } finally {
    await world.close();
  }
});

/**
 * Deep copy of the fake board. Undo is judged against this map, not against
 * the append-only mutation log.
 *
 * @param {{issues: Map<string, object>}} jira
 * @returns {Map<string, object>}
 */
function cloneIssueMap(jira) {
  const board = new Map();
  for (const [key, issue] of jira.issues) {
    board.set(key, JSON.parse(JSON.stringify(issue)));
  }
  return board;
}

/**
 * @param {object|undefined} issue
 * @returns {number}
 */
function commentCount(issue) {
  const comments = issue?.fields?.comment?.comments;
  return Array.isArray(comments) ? comments.length : 0;
}

testSerial('blast undo returns the board to the seed and a redelivered undo does not write', async () => {
  const world = await createWorld();
  try {
    const epicKey = DEMO_KEYS.refundsEpic;
    const seedBoard = cloneIssueMap(world.jira);
    const planned = await world.invoke('plan-split', {
      epicKey,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Research refunds', workerType: 'research', input: GOAL, dependsOn: [] },
        { title: 'Check capture links', workerType: 'check-deps', input: GOAL, dependsOn: [0] },
        {
          title: 'Draft the refund spec',
          workerType: 'draft-spec',
          input: {
            description: GOAL,
            transitionTo: 'In Progress',
            transitionTarget: 'epic',
          },
          dependsOn: [1],
        },
      ],
    });
    assert.equal(planned.ok, true, planned.error);
    // The epic transition scores 4 and the three children score 1 each, so
    // the plan is over the threshold. plan-split appends one approval gate
    // and every original step waits on it. The run cannot finish, and the
    // Epic cannot move, until that gate is approved.
    assert.equal(planned.steps.length, 4);
    const gatePlan = planned.steps.find((step) => step.workerType === 'approval');
    assert.ok(gatePlan);
    assert.equal(planned.blastRadius.risk.exceeds, true);
    assert.equal(planned.blastRadius.gate.insert, false);
    for (const step of planned.steps) {
      if (step.workerType === 'approval') continue;
      assert.ok(step.dependsOn.includes(gatePlan.idx));
    }
    const dispatched = await world.invoke('dispatch-run', { runId: planned.runId });
    assert.equal(dispatched.ok, true, dispatched.error);
    await world.drain();
    assert.equal((await world.store.getRun(planned.runId)).status, 'running');
    const held = await world.store.listSteps(planned.runId);
    assert.ok(held.every((step) => step.status === 'waiting'));
    await approveGate(gatePlan.stepId, { actor: 'manager-1' }, world.runtime);
    await world.drain();
    const finished = await world.store.getRun(planned.runId);
    assert.equal(finished.status, 'done');
    assert.equal(
      world.jira.issues.get(epicKey).fields.status.name,
      'In Progress',
      'the run transitioned the Epic',
    );

    const forward = await world.store.listEffectsByRun(planned.runId);
    const plan = planCompensations(forward);
    assert.deepEqual(plan.cannotUndo.map((item) => item.reason), []);
    assert.equal(plan.compensations.some((item) => item.kind === 'closeIssue'), true);
    assert.equal(plan.compensations.some((item) => item.kind === 'recordRemovedComment'), true);
    const restore = plan.compensations.find((item) => item.kind === 'restoreStatus');
    assert.ok(restore, 'restoreStatus was not planned');
    assert.equal(restore.payload.issueKey, epicKey);
    assert.equal(restore.payload.toStatusName, 'To Do');
    assert.equal(restore.payload.expectedStatusName, 'In Progress');
    const stepsById = new Map(
      (await world.store.listSteps(planned.runId)).map((step) => [step.stepId, step]),
    );
    for (const close of plan.compensations.filter((item) => item.kind === 'closeIssue')) {
      const owner = stepsById.get(close.stepId);
      if (owner?.workerType === 'approval') {
        // The gate has a child and no worker comment, so close has nothing to wait for.
        assert.equal(close.dependsOnKeys.length, 0);
        continue;
      }
      assert.ok(close.dependsOnKeys.length > 0, `${close.payload.issueKey} closed before its comment`);
    }

    const enqueued = await enqueueCompensations(plan);
    assert.ok(enqueued.length > 0);
    assert.ok(enqueued.every((item) => item.created === true));
    await world.drain();

    /** @type {string[]} */
    const residue = [];
    for (const [key, issue] of world.jira.issues) {
      if (seedBoard.has(key)) {
        assert.deepEqual(JSON.parse(JSON.stringify(issue)), seedBoard.get(key), key);
        assert.equal(commentCount(issue), 0, `${key} still has a comment`);
      } else {
        residue.push(key);
        assert.equal(isRollbackResidue(issue), true, `${key} was not closed and labelled`);
        assert.equal(commentCount(issue), 0, `${key} still has a comment`);
        assert.notEqual(key.startsWith('PAY-'), false);
      }
    }
    const created = world.jira.mutationsOf('createIssue').map((mutation) => mutation.issueKey);
    assert.deepEqual(residue.sort(), [...created].sort());
    assert.ok(created.length >= 3);

    const effects = await world.store.listEffectsByRun(planned.runId);
    const compensations = effects.filter((effect) => (
      effect.kind === 'closeIssue'
      || effect.kind === 'recordRemovedComment'
      || effect.kind === 'restoreStatus'
    ));
    assert.equal(compensations.length, enqueued.length);
    for (const effect of compensations) {
      assert.equal(effect.status, 'applied', effect.kind);
      assert.equal(effect.tries, 1, effect.kind);
    }
    for (const effect of effects.filter((effect) => effect.kind === 'createIssue')) {
      assert.equal(effect.status, 'applied');
    }

    const callsBefore = world.jira.calls.length;
    const mutationsBefore = world.jira.mutations.length;
    const writesBefore = world.sdk.usage().writes;
    await effectApplierHandler({ body: { requestKey: compensations[0].requestKey } });
    assert.equal(world.jira.calls.length, callsBefore, 'redelivered undo called Jira');
    assert.equal(world.jira.mutations.length, mutationsBefore, 'redelivered undo mutated Jira');
    assert.equal(world.sdk.usage().writes, writesBefore, 'redelivered undo wrote KVS');
    assert.equal((await world.store.getEffect(compensations[0].requestKey)).tries, 1);

    const againPlan = planCompensations(await world.store.listEffectsByRun(planned.runId));
    const writesBeforeSecond = world.sdk.usage().writes;
    const mutationsBeforeSecond = world.jira.mutations.length;
    const second = await enqueueCompensations(againPlan);
    assert.equal(second.length, enqueued.length);
    assert.ok(second.every((item) => item.created === false));
    await world.drain();
    assert.equal(world.jira.mutations.length, mutationsBeforeSecond);
    assert.equal(world.sdk.usage().writes, writesBeforeSecond);

    const jiraWritesBeforeReplay = jiraWriteCount(world);
    const replay = await world.invoke('replay-run', { runId: planned.runId });
    assert.equal(replay.ok, true, replay.error);
    assert.equal(replay.duplicateWrites, 0);
    assert.equal(jiraWriteCount(world), jiraWritesBeforeReplay);

    const issueDeletes = world.jira.calls.filter((call) => (
      call.method === 'DELETE' && !String(call.pathname).includes('/comment/')
    ));
    assert.deepEqual(issueDeletes, []);

    assertWithinBudget(world.sdk, 'blast-undo');
  } finally {
    await world.close();
  }
});

testSerial('an approval gate holds its dependents while a sibling finishes', async () => {
  const world = await createWorld();
  try {
    const planned = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
        { title: 'Approve the refund spec', workerType: 'approval', input: 'a person signs off', dependsOn: [] },
        { title: 'Draft the refund spec', workerType: 'draft-spec', input: 'idempotent on the payment id', dependsOn: [1] },
      ],
    });
    assert.equal(planned.ok, true, planned.error);
    assert.equal(planned.steps.length, 3);
    assert.equal(planned.steps[1].workerType, 'approval');
    assert.deepEqual(planned.steps[0].dependsOn, []);
    assert.deepEqual(planned.steps[2].dependsOn, [1]);
    assert.equal(planned.blastRadius.gate.insert, false);

    await world.invoke('dispatch-run', { runId: planned.runId });
    await world.drain();

    const mid = await world.store.listSteps(planned.runId);
    const research = mid.find((step) => step.workerType === 'research');
    const gate = mid.find((step) => step.workerType === 'approval');
    const draft = mid.find((step) => step.workerType === 'draft-spec');
    assert.equal(research.status, 'done');
    assert.equal(gate.status, 'waiting');
    assert.equal(gate.attempt, 0);
    assert.equal(draft.status, 'waiting');
    assert.equal(draft.attempt, 0);
    assert.equal((await world.store.getRun(planned.runId)).status, 'running');
    assert.ok(gate.childIssueKey);
    assert.equal(draft.childIssueKey ?? null, null);
    const gateComments = world.jira.mutationsOf('comment').filter((comment) => (
      comment.issueKey === gate.childIssueKey
    ));
    assert.equal(gateComments.length, 0);
    assert.equal(world.jira.mutationsOf('createIssue').length, 2);

    world.clock.advance(STEP_DEADLINE_MS + STUCK_QUEUED_MS);
    const pass = await world.watchdog.run();
    assert.equal(pass.scannedSteps, 0);
    assert.equal(pass.retriedSteps.length, 0);
    assert.equal(pass.failedSteps.length, 0);
    const held = await world.store.listSteps(planned.runId);
    assert.equal(held.find((step) => step.stepId === gate.stepId).status, 'waiting');
    assert.equal(held.find((step) => step.stepId === gate.stepId).attempt, 0);
    assert.equal(held.find((step) => step.stepId === draft.stepId).attempt, 0);
    const events = await world.store.listEventsByRun(planned.runId);
    assert.equal(events.some((event) => event.kind === 'step.retried'), false);

    const approved = await approveGate(gate.stepId, {
      actor: 'manager-1',
      note: 'the spec can proceed',
    }, world.runtime);
    assert.equal(approved.approved, true);
    assert.equal(approved.duplicate, false);
    await world.drain();

    const finished = await world.store.getRun(planned.runId);
    assert.equal(finished.status, 'done');
    const steps = await world.store.listSteps(planned.runId);
    const doneDraft = steps.find((step) => step.stepId === draft.stepId);
    const doneGate = steps.find((step) => step.stepId === gate.stepId);
    assert.equal(doneGate.status, 'done');
    assert.equal(doneGate.output.approved, true);
    assert.equal(doneGate.output.actor, 'manager-1');
    assert.equal(doneGate.attempt, 0);
    assert.equal(doneDraft.status, 'done');
    assert.equal(doneDraft.dependencyContext.length, 1);
    assert.equal(doneDraft.dependencyContext[0].workerType, 'approval');
    assert.equal(doneDraft.dependencyContext[0].output.approved, true);
    assert.equal(steps.find((step) => step.stepId === research.stepId).status, 'done');
    assert.equal(typeof doneDraft.childIssueKey, 'string');
    assert.equal(world.jira.mutationsOf('createIssue').length, 3);
    assertWithinBudget(world.sdk, 'approval-gate');
  } finally {
    await world.close();
  }
});

testSerial('transitioning the gate child approves it and starts the downstream step', async () => {
  const world = await createWorld();
  try {
    const planned = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Approve the refund spec', workerType: 'approval', input: 'a person signs off', dependsOn: [] },
        { title: 'Draft the refund spec', workerType: 'draft-spec', input: 'idempotent on the payment id', dependsOn: [0] },
      ],
    });
    assert.equal(planned.ok, true, planned.error);
    assert.equal(planned.steps.length, 2);
    assert.equal(planned.steps[0].workerType, 'approval');
    assert.deepEqual(planned.steps[1].dependsOn, [0]);
    assert.equal(planned.blastRadius.gate.insert, false);

    await world.invoke('dispatch-run', { runId: planned.runId });
    await world.drain();

    const mid = await world.store.listSteps(planned.runId);
    const gate = mid.find((step) => step.workerType === 'approval');
    const draft = mid.find((step) => step.workerType === 'draft-spec');
    assert.equal(gate.status, 'waiting');
    assert.equal(gate.attempt, 0);
    assert.equal(draft.status, 'waiting');
    assert.equal(draft.attempt, 0);
    assert.equal((await world.store.getRun(planned.runId)).status, 'running');
    assert.equal(typeof gate.childIssueKey, 'string');
    assert.equal(
      world.jira.mutationsOf('comment').filter((comment) => comment.issueKey === gate.childIssueKey).length,
      0,
    );
    assert.equal(world.jira.mutationsOf('transition').length, 0);
    assert.equal(world.bus.ready('step-queue'), 0);

    // Both rows are waiting, which findStuckSteps does not return. A gate
    // that is waiting on a person must not burn an attempt.
    world.clock.advance(STEP_DEADLINE_MS + STUCK_QUEUED_MS);
    const pass = await world.watchdog.run();
    assert.equal(pass.scannedSteps, 0);
    assert.equal(pass.retriedSteps.length, 0);
    assert.equal(pass.failedSteps.length, 0);
    const held = await world.store.listSteps(planned.runId);
    assert.equal(held.find((step) => step.stepId === gate.stepId).status, 'waiting');
    assert.equal(held.find((step) => step.stepId === gate.stepId).attempt, 0);
    assert.equal(held.find((step) => step.stepId === draft.stepId).status, 'waiting');
    assert.equal(held.find((step) => step.stepId === draft.stepId).attempt, 0);
    const beforeEvents = await world.store.listEventsByRun(planned.runId);
    assert.equal(beforeEvents.some((event) => event.kind === 'step.retried'), false);

    const triggersBefore = world.jira.productEvents.length;
    const approved = await world.transitionIssue(gate.childIssueKey, 'Done', {
      actor: 'manager-1',
    });
    assert.equal(approved.ok, true);
    assert.equal(approved.trigger?.status, 'reported');
    assert.equal(approved.trigger?.approved, true);
    assert.equal(approved.trigger?.duplicate, false);
    assert.equal(world.jira.productEvents.length, triggersBefore + 1);
    assert.equal(world.jira.issues.get(gate.childIssueKey).fields.status.name, 'Done');
    assert.equal(world.jira.mutationsOf('transition').length, 1);

    const doneGate = await world.store.getStep(gate.stepId);
    assert.equal(doneGate.status, 'done');
    assert.equal(doneGate.attempt, 0);
    assert.equal(doneGate.output.approved, true);
    assert.equal(doneGate.output.actor, 'manager-1');
    assert.equal(doneGate.output.note, 'Transitioned to Done');
    assert.equal(doneGate.output.generator, 'human');
    const queuedDraft = await world.store.getStep(draft.stepId);
    assert.equal(queuedDraft.status, 'queued');
    assert.equal(queuedDraft.attempt, 0);
    const queued = world.bus.peek('step-queue').map((event) => event.body.stepId);
    assert.deepEqual(queued, [draft.stepId]);

    // A second delivery of the same transition must not queue the draft again.
    const again = await world.transitionIssue(gate.childIssueKey, 'Done', {
      actor: 'someone-else',
    });
    assert.equal(again.ok, true);
    assert.equal(again.trigger?.duplicate, true);
    assert.equal(again.trigger?.approved, true);
    assert.deepEqual(
      world.bus.peek('step-queue').map((event) => event.body.stepId),
      [draft.stepId],
    );
    const unchanged = await world.store.getStep(gate.stepId);
    assert.equal(unchanged.output.actor, 'manager-1');
    assert.equal(unchanged.output.generator, 'human');

    await world.drain();
    const finished = await world.store.getRun(planned.runId);
    assert.equal(finished.status, 'done');
    const steps = await world.store.listSteps(planned.runId);
    const doneDraft = steps.find((step) => step.stepId === draft.stepId);
    assert.equal(doneDraft.status, 'done');
    assert.equal(doneDraft.attempt, 0);
    assert.equal(doneDraft.dependencyContext.length, 1);
    assert.equal(doneDraft.dependencyContext[0].workerType, 'approval');
    assert.equal(doneDraft.dependencyContext[0].output.approved, true);
    assert.equal(doneDraft.dependencyContext[0].output.actor, 'manager-1');
    assert.equal(doneDraft.dependencyContext[0].output.generator, 'human');
    const events = await world.store.listEventsByRun(planned.runId);
    assert.equal(events.some((event) => event.kind === 'step.retried'), false);
    assertWithinBudget(world.sdk, 'approval-trigger');
  } finally {
    await world.close();
  }
});

testSerial('a plan over the blast threshold grows one approval gate', async () => {
  const world = await createWorld();
  try {
    const callerSteps = Array.from({ length: 5 }, (_, index) => ({
      title: `Refund step ${index}`,
      workerType: index === 2 ? 'draft-spec' : 'research',
      input: 'refunds',
      dependsOn: [],
    }));
    const planned = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: callerSteps,
    });
    assert.equal(planned.ok, true, planned.error);
    assert.equal(planned.steps.length, 6);
    const gate = planned.steps[5];
    assert.equal(gate.workerType, 'approval');
    assert.equal(gate.title, 'Approve blast radius');
    assert.deepEqual(gate.dependsOn, []);
    for (let index = 0; index < 5; index += 1) {
      assert.equal(planned.steps[index].title, callerSteps[index].title);
      assert.ok(planned.steps[index].dependsOn.includes(gate.idx));
    }
    assert.equal(planned.blastRadius.risk.score, 5);
    assert.equal(planned.blastRadius.risk.exceeds, true);
    assert.equal(planned.blastRadius.gate.insert, false);
    assert.match(planned.blastRadius.gate.reason, /already in the plan/);
    assert.equal(
      planned.blastRadius.writes.filter((write) => write.template === 'approval-child').length,
      1,
    );

    await world.invoke('dispatch-run', { runId: planned.runId });
    await world.drain();
    const stored = await world.store.listSteps(planned.runId);
    assert.equal(stored.length, 6);
    for (const step of stored) {
      assert.equal(step.status, 'waiting');
      assert.equal(step.attempt, 0);
      if (step.workerType === 'approval') {
        assert.equal(typeof step.childIssueKey, 'string');
      } else {
        assert.equal(step.childIssueKey ?? null, null);
      }
    }
    assert.equal(world.jira.mutationsOf('createIssue').length, 1);
    assert.equal(world.jira.mutationsOf('comment').length, 0);
    assert.equal((await world.store.getRun(planned.runId)).status, 'running');

    world.clock.advance(STEP_DEADLINE_MS + STUCK_QUEUED_MS);
    const pass = await world.watchdog.run();
    assert.equal(pass.scannedSteps, 0);
    assert.equal(pass.retriedSteps.length, 0);
    const after = await world.store.listSteps(planned.runId);
    assert.ok(after.every((step) => step.status === 'waiting' && step.attempt === 0));
    const events = await world.store.listEventsByRun(planned.runId);
    assert.equal(events.some((event) => event.kind === 'step.retried'), false);
    assertWithinBudget(world.sdk, 'approval-blast');
  } finally {
    await world.close();
  }
});

testSerial('an accepted lesson that needs a person inserts one approval gate', async () => {
  const world = await createWorld();
  try {
    const added = await addLesson({
      projectKey: DEMO_KEYS.projectKey,
      scope: 'project',
      epicKey: DEMO_KEYS.refundsEpic,
      goal: GOAL,
      workerType: 'draft-spec',
      text: 'The draft-spec step needs a person before it writes the refund spec.',
      cause: 'draft-spec needs a person',
    }, { store: world.store });
    const accepted = await acceptLesson({
      projectKey: DEMO_KEYS.projectKey,
      lessonId: added.lessonId,
    }, { store: world.store });

    const planned = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
        { title: 'Draft the refund spec', workerType: 'draft-spec', input: 'idempotent on the payment id', dependsOn: [0] },
      ],
    });
    assert.equal(planned.ok, true, planned.error);
    assert.equal(planned.steps.length, 3);
    assert.equal(planned.steps[0].workerType, 'research');
    assert.deepEqual(planned.steps[0].dependsOn, []);
    assert.equal(planned.steps[1].workerType, 'draft-spec');
    const gate = planned.steps.find((step) => step.workerType === 'approval');
    assert.ok(gate);
    assert.deepEqual(gate.dependsOn, []);
    assert.ok(planned.steps[1].dependsOn.includes(gate.idx));
    assert.equal(planned.steps[1].dependsOn.includes(0), true);
    assert.deepEqual(planned.usedLessons, [accepted.lessonId]);
    assert.match(String(planned.planCard), new RegExp(accepted.lessonId));
    assert.match(String(planned.planCard), /a person must approve/);
    assert.equal(planned.steps.some((step) => step.workerType === 'check-deps'), false);

    await world.drainEffects();
    const plans = world.jira.mutationsOf('comment').filter((comment) => (
      comment.bodyText.startsWith('[Conductor plan]')
    ));
    assert.equal(plans.length, 1);
    assert.match(plans[0].bodyText, new RegExp(accepted.lessonId));
    assert.equal(world.jira.mutationsOf('createIssue').length, 0);

    await world.invoke('dispatch-run', { runId: planned.runId });
    await world.drain();
    const mid = await world.store.listSteps(planned.runId);
    const research = mid.find((step) => step.workerType === 'research');
    const storedGate = mid.find((step) => step.workerType === 'approval');
    const draft = mid.find((step) => step.workerType === 'draft-spec');
    assert.equal(research.status, 'done');
    assert.equal(storedGate.status, 'waiting');
    assert.equal(storedGate.attempt, 0);
    assert.equal(draft.status, 'waiting');
    assert.equal(draft.attempt, 0);
    assert.equal(
      world.jira.mutationsOf('comment').filter((comment) => comment.issueKey === storedGate.childIssueKey).length,
      0,
    );

    world.clock.advance(STEP_DEADLINE_MS + STUCK_QUEUED_MS);
    const pass = await world.watchdog.run();
    assert.equal(pass.retriedSteps.length, 0);
    assert.equal(pass.scannedSteps, 0);
    assert.equal((await world.store.getStep(storedGate.stepId)).attempt, 0);
    assert.equal((await world.store.getStep(draft.stepId)).status, 'waiting');

    await approveGate(storedGate.stepId, { actor: 'manager-1' }, world.runtime);
    await world.drain();
    const doneDraft = await world.store.getStep(draft.stepId);
    assert.equal(doneDraft.status, 'done');
    assert.equal(doneDraft.attempt, 0);
    assert.ok(doneDraft.dependencyContext.some((entry) => (
      entry.workerType === 'approval' && entry.output.approved === true
    )));
    assert.equal((await world.store.getRun(planned.runId)).status, 'done');
    assertWithinBudget(world.sdk, 'approval-lesson');
  } finally {
    await world.close();
  }
});

testSerial('a run stores its step, model, and wall-clock budget', async () => {
  // The scripted model is on so the counters move. The reply is not a lead
  // action, so the wave still stops on the rules. No live site, no ETA.
  const world = await createWorld({
    llm: {
      mode: 'script',
      reply: () => '{"summary":"Refunds stay idempotent on the payment id."}',
    },
  });
  try {
    const planned = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Research refund issues', workerType: 'research', input: 'refunds', dependsOn: [] },
        { title: 'Draft the refund spec', workerType: 'draft-spec', input: 'idempotent refund', dependsOn: [0] },
      ],
    });
    assert.equal(planned.ok, true, planned.error);
    const plannedRun = await world.store.getRun(planned.runId);
    assert.equal(plannedRun.budget.maxSteps, RUN_MAX_STEPS);
    assert.equal(plannedRun.budget.maxModelCalls, RUN_MAX_MODEL_CALLS);
    assert.equal(plannedRun.budget.wallClockMs, RUN_WALL_CLOCK_MS);
    assert.equal(plannedRun.budget.usedSteps, 2);
    assert.equal(plannedRun.budget.usedModelCalls, 0);
    assert.equal(plannedRun.budget.usedTokens, 0);
    assert.equal(plannedRun.budget.elapsedMs, 0);
    assert.equal(plannedRun.budget.startedAt, plannedRun.createdAt);
    assert.equal(Object.hasOwn(plannedRun.budget, 'criticalPath'), false);
    assert.equal(Object.hasOwn(plannedRun, 'eta'), false);
    assert.equal(Object.hasOwn(plannedRun, 'etaMs'), false);

    const advanced = 5 * 60 * 1000;
    world.clock.advance(advanced);
    const dispatched = await world.invoke('dispatch-run', { runId: planned.runId });
    assert.equal(dispatched.ok, true, dispatched.error);
    const running = await world.store.getRun(planned.runId);
    assert.equal(running.status, 'running');
    assert.equal(running.budget.elapsedMs, advanced);
    assert.equal(running.budget.usedSteps, 2);
    assert.equal(running.budget.usedModelCalls, 0);

    await world.drain();
    const finished = await world.store.getRun(planned.runId);
    assert.equal(finished.status, 'done');
    const steps = await world.store.listSteps(planned.runId);
    const work = steps.filter((step) => step.workerType !== 'summarize');
    assert.equal(work.length, 2);
    assert.equal(finished.budget.usedSteps, 2);
    assert.ok(world.llm.calls.length > 0);
    assert.equal(finished.budget.usedModelCalls, world.llm.calls.length);
    // The fake reports 12 input tokens and 24 output tokens on every chat.
    assert.equal(finished.budget.usedTokens, finished.budget.usedModelCalls * 36);
    assert.equal(finished.budget.elapsedMs, advanced);
    assert.equal(isWithinRunBudget(finished.budget), true);
    assert.equal(Object.hasOwn(finished.budget, 'criticalPath'), false);
    assert.equal(Object.hasOwn(finished, 'eta'), false);

    const status = await world.invoke('get-run-status', { runId: planned.runId });
    assert.equal(status.ok, true);
    assert.equal(status.run.budget.usedSteps, 2);
    assert.equal(status.run.budget.usedModelCalls, finished.budget.usedModelCalls);
    assert.equal(status.run.budget.usedTokens, finished.budget.usedTokens);
    assert.equal(status.run.budget.elapsedMs, advanced);
    assert.equal(status.run.budget.maxSteps, RUN_MAX_STEPS);
    assert.deepEqual(world.fetches, []);
    assertWithinBudget(world.sdk, 'run-budget');
  } finally {
    await world.close();
  }
});

testSerial('the critical path, the ETA, and a merge when the budget is over', async () => {
  // Planning only. No dispatch, so nothing is written to Jira and the model
  // stays off. The first plan fits. The second is one chain that is longer
  // than the wall-clock cap until two cheap steps are joined.
  const world = await createWorld();
  const longMs = 70 * 60 * 1000;
  try {
    const fit = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Find refund issues', workerType: 'research', input: 'refunds', dependsOn: [] },
        { title: 'Find ledger issues', workerType: 'research', input: 'ledger', dependsOn: [] },
        { title: 'Draft the refund spec', workerType: 'draft-spec', input: 'spec', dependsOn: [0] },
        { title: 'Check capture links', workerType: 'check-deps', input: 'links', dependsOn: [2] },
        { title: 'Approve the spec', workerType: 'approval', input: 'approve', dependsOn: [3] },
      ],
    });
    assert.equal(fit.ok, true, fit.error);
    assert.equal(fit.budgetReplan.applied, false);
    assert.equal(fit.budgetReplan.reason, REPLAN_WITHIN_BUDGET);
    assert.equal(fit.steps.length, 5);
    assert.equal(fit.steps[4].workerType, 'approval');
    assert.deepEqual(fit.steps[2].dependsOn, [0]);
    assert.deepEqual(fit.steps[4].dependsOn, [3]);

    const fitRun = await world.store.getRun(fit.runId);
    assert.equal(fitRun.status, 'planning');
    assert.equal(fitRun.budget.usedSteps, 5);
    assert.equal(Object.hasOwn(fitRun.budget, 'criticalPath'), false);
    assert.equal(Object.hasOwn(fitRun, 'eta'), false);
    assert.equal(Object.hasOwn(fitRun, 'criticalPath'), false);
    const fitEvents = await world.store.listEventsByRun(fit.runId);
    const fitCreated = fitEvents.find((event) => event.kind === 'plan.created');
    assert.equal(Object.hasOwn(fitCreated.detail, 'budgetReplan'), false);
    assert.equal(fitEvents.some((event) => event.kind === 'replan'), false);

    const fitStatus = await world.invoke('get-run-status', { runId: fit.runId });
    assert.equal(fitStatus.ok, true);
    // 0 -> 2 -> 3 -> 4. Step 1 is a shorter branch and is not on the path.
    // The approval gate is waiting-work: it is on the path. Summarize is
    // not in the plan yet, so it cannot extend the ETA.
    assert.deepEqual(fitStatus.run.criticalPath.indexes, [0, 2, 3, 4]);
    assert.equal(fitStatus.run.criticalPath.indexes.includes(1), false);
    assert.equal(fitStatus.run.criticalPath.durationMs, 4 * STEP_DEADLINE_MS);
    assert.equal(fitStatus.run.eta.remainingMs, 4 * STEP_DEADLINE_MS);
    assert.equal(fitStatus.run.eta.finishAt, world.clock.now + fitStatus.run.eta.remainingMs);
    assert.equal(fitStatus.run.budgetOutlook.over, false);
    assert.deepEqual(fitStatus.run.budgetOutlook.reasons, []);
    const fitSteps = await world.store.listSteps(fit.runId);
    assert.deepEqual(
      fitStatus.run.criticalPath.keys,
      [0, 2, 3, 4].map((idx) => fitSteps.find((row) => row.idx === idx).stepId),
    );
    assert.equal(fitStatus.run.budget.usedSteps, 5);
    assert.equal(fitStatus.run.budget.maxSteps, RUN_MAX_STEPS);
    assert.equal(Object.hasOwn(fitStatus.run.budget, 'criticalPath'), false);

    const advanced = 5 * 60 * 1000;
    world.clock.advance(advanced);
    const later = await world.invoke('get-run-status', { runId: fit.runId });
    assert.equal(later.run.eta.remainingMs, fitStatus.run.eta.remainingMs);
    assert.equal(later.run.eta.finishAt, fitStatus.run.eta.finishAt + advanced);
    assert.equal(later.run.eta.finishAt, world.clock.now + later.run.eta.remainingMs);
    assert.equal(later.run.budget.elapsedMs, 0);
    assert.equal(later.run.budgetOutlook.over, false);

    const heavy = [
      { title: 'Scan refund issues', workerType: 'research', input: 'refunds', dependsOn: [] },
      { title: 'Scan ledger rows', workerType: 'research', input: 'ledger', dependsOn: [0] },
      {
        title: 'Write the long spec',
        workerType: 'draft-spec',
        input: 'long spec',
        durationMs: longMs,
        dependsOn: [1],
      },
      { title: 'Check capture links', workerType: 'check-deps', input: 'links', dependsOn: [2] },
    ];
    const before = criticalPathOf(heavy.map((row, idx) => ({ ...row, idx })), world.clock.now);
    assert.deepEqual(before.indexes, [0, 1, 2, 3]);
    assert.equal(before.durationMs, (3 * STEP_DEADLINE_MS) + longMs);
    assert.ok(before.durationMs > RUN_WALL_CLOCK_MS);

    const merged = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: `${GOAL} on a long spec`,
      steps: heavy,
    });
    assert.equal(merged.ok, true, merged.error);
    assert.equal(merged.budgetReplan.applied, true);
    assert.equal(merged.budgetReplan.reason, REPLAN_MERGED);
    assert.deepEqual(merged.budgetReplan.mergedIdxs, [0, 1]);
    assert.equal(merged.steps.length, 3);
    assert.equal(merged.steps[0].title, 'Scan refund issues + Scan ledger rows');
    assert.equal(merged.steps[0].workerType, 'research');
    assert.equal(merged.steps[0].input.merged, true);
    assert.equal(merged.steps[0].input.durationMs, STEP_DEADLINE_MS);
    assert.equal(merged.steps[1].title, 'Write the long spec');
    assert.equal(merged.steps[1].input.durationMs, longMs);
    assert.deepEqual(merged.steps[1].dependsOn, [0]);
    assert.equal(merged.steps[2].workerType, 'check-deps');
    assert.deepEqual(merged.steps[2].dependsOn, [1]);

    const mergedRun = await world.store.getRun(merged.runId);
    assert.equal(mergedRun.status, 'planning');
    assert.equal(mergedRun.budget.usedSteps, 3);
    assert.equal(Object.hasOwn(mergedRun.budget, 'criticalPath'), false);
    const mergedEvents = await world.store.listEventsByRun(merged.runId);
    const mergedCreated = mergedEvents.find((event) => event.kind === 'plan.created');
    assert.deepEqual(mergedCreated.detail.budgetReplan.mergedIdxs, [0, 1]);
    assert.equal(mergedEvents.some((event) => event.kind === 'replan'), false);

    const mergedStatus = await world.invoke('get-run-status', { runId: merged.runId });
    const expected = STEP_DEADLINE_MS + longMs + STEP_DEADLINE_MS;
    assert.deepEqual(mergedStatus.run.criticalPath.indexes, [0, 1, 2]);
    assert.equal(mergedStatus.run.criticalPath.durationMs, expected);
    assert.equal(mergedStatus.run.eta.remainingMs, expected);
    assert.equal(mergedStatus.run.eta.finishAt, world.clock.now + expected);
    assert.ok(expected <= RUN_WALL_CLOCK_MS);
    assert.equal(mergedStatus.run.budgetOutlook.over, false);
    const mergedSteps = await world.store.listSteps(merged.runId);
    assert.deepEqual(
      mergedStatus.run.criticalPath.keys,
      mergedSteps.map((row) => row.stepId),
    );
    assert.equal(world.llm.calls.length, 0);
    assert.equal(world.jira.mutationsOf('createIssue').length, 0);
    assert.deepEqual(world.fetches, []);
    assertWithinBudget(world.sdk, 'critical-path');
  } finally {
    await world.close();
  }
});

testSerial('chaos counters record one duplicate and one heal on the run', async () => {
  // The gate is open for this world only. Other scenarios leave `env` empty,
  // so their runs do not grow a chaos object.
  const world = await createWorld({
    env: {
      [FAULT_INJECTION_ENV]: 'simulation',
      [SIMULATION_ENV]: '1',
    },
  });
  try {
    const planned = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
      ],
    });
    assert.equal(planned.ok, true, planned.error);
    const before = await world.invoke('get-run-status', { runId: planned.runId });
    assert.deepEqual(before.run.budget.chaos, { injected: 0, healed: 0, duplicateWrites: 0 });
    assert.equal(Object.hasOwn((await world.store.getRun(planned.runId)).budget, 'chaos'), false);

    // After the plan, before dispatch. The first push is the child issue.
    // A second message for that same request key is the injected fault.
    assert.equal(injectFault({ type: 'duplicate-effect' }, world.env).armed, true);
    const dispatched = await world.invoke('dispatch-run', { runId: planned.runId });
    assert.equal(dispatched.ok, true, dispatched.error);
    await world.drain();

    const status = await world.invoke('get-run-status', { runId: planned.runId });
    assert.equal(status.run.status, 'done');
    assert.deepEqual(status.run.budget.chaos, { injected: 1, healed: 1, duplicateWrites: 0 });
    const stored = await world.store.getRun(planned.runId);
    assert.deepEqual(stored.budget.chaos, { injected: 1, healed: 1, duplicateWrites: 0 });
    assert.equal(world.jira.mutationsOf('createIssue').length, 1);
    const panel = await loadRun(planned.runId);
    assert.deepEqual(panel.chaos, status.run.budget.chaos);
    assert.deepEqual(world.fetches, []);
    assertWithinBudget(world.sdk, 'chaos-counters');
  } finally {
    await world.close();
  }
});

testSerial('chaos proof heals a kill, a duplicate, and a 429 in one run', async () => {
  // One research step, three armed faults, each aimed at a different hook so
  // the counters cannot hide behind each other:
  // - duplicate-effect on the child-issue request key (the dispatch push)
  // - jira-429 on the research-comment request key (the worker's one comment)
  // - kill-worker on that step, after it has read its evidence
  // The watchdog is what retries the kill. The effect queue's own delay is
  // what retries the 429. The duplicate is dropped because the row is already
  // applied. Jira still mutates each key once.
  const world = await createWorld({
    env: {
      [FAULT_INJECTION_ENV]: 'simulation',
      [SIMULATION_ENV]: '1',
    },
  });
  try {
    const planned = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
      ],
    });
    assert.equal(planned.ok, true, planned.error);
    assert.equal(planned.steps.length, 1);
    const stepId = planned.steps[0].stepId;
    const childKey = requestKeyFor({
      runId: planned.runId,
      stepId,
      kind: 'createIssue',
      discriminator: 'child-issue',
    });
    const commentKey = requestKeyFor({
      runId: planned.runId,
      stepId,
      kind: 'comment',
      discriminator: 'research-comment',
    });

    const before = await world.invoke('get-run-status', { runId: planned.runId });
    assert.deepEqual(before.run.budget.chaos, { injected: 0, healed: 0, duplicateWrites: 0 });
    assert.equal(Object.hasOwn((await world.store.getRun(planned.runId)).budget, 'chaos'), false);

    // Arm after the plan and before dispatch. A fault with no target would
    // hit whichever hook ran first, and the 429 and the duplicate would
    // land on the same child issue.
    assert.equal(injectFault({ type: 'duplicate-effect', requestKey: childKey }, world.env).armed, true);
    assert.equal(injectFault({ type: 'jira-429', requestKey: commentKey }, world.env).armed, true);
    assert.equal(injectFault({ type: 'kill-worker', stepId }, world.env).armed, true);

    const dispatched = await world.invoke('dispatch-run', { runId: planned.runId });
    assert.equal(dispatched.ok, true, dispatched.error);
    const killed = await world.drain();
    assert.equal(killed.length, 1);
    assert.equal(killed[0].status, 'killed');
    assert.equal(killed[0].fault, 'kill-worker');
    assert.equal(killed[0].at, 'after-evidence');

    // The child exists. The comment does not: the kill returned before
    // enqueueEffect. The second child-issue delivery was dropped.
    const hung = (await world.store.listSteps(planned.runId)).find((step) => step.stepId === stepId);
    assert.equal(hung.status, 'running');
    assert.equal(hung.attempt, 0);
    assert.equal(typeof hung.childIssueKey, 'string');
    assert.equal(world.jira.mutationsOf('createIssue').length, 1);
    assert.equal(
      world.jira.mutationsOf('comment').filter((comment) => comment.issueKey === hung.childIssueKey).length,
      0,
    );
    const childEffect = await world.store.getEffect(childKey);
    assert.equal(childEffect.status, 'applied');
    assert.equal(childEffect.tries, 1);
    assert.equal(await world.store.getEffect(commentKey), null);
    const afterKill = await world.invoke('get-run-status', { runId: planned.runId });
    assert.deepEqual(afterKill.run.budget.chaos, { injected: 2, healed: 1, duplicateWrites: 0 });

    // The deadline has not passed, so the watchdog leaves the killed step.
    const tooSoon = await world.watchdog.run();
    assert.equal(tooSoon.retriedSteps.length, 0);
    assert.equal((await world.store.getStep(stepId)).attempt, 0);

    world.clock.advance(STEP_DEADLINE_MS + 1000);
    const pass = await world.watchdog.run();
    assert.equal(pass.retriedSteps.length, 1);
    assert.equal(pass.retriedSteps[0].stepId, stepId);
    assert.equal(pass.retriedSteps[0].attempt, 1);
    const healedKill = await world.invoke('get-run-status', { runId: planned.runId });
    assert.deepEqual(healedKill.run.budget.chaos, { injected: 2, healed: 2, duplicateWrites: 0 });

    // The retry finishes the step and queues the comment. That comment's
    // first Jira call is the injected 429, so the effect sits in `retrying`
    // until the queue delay elapses. The wave report and the memory comment
    // are different request keys and apply on this same drain.
    await world.drain();
    const retrying = await world.store.getEffect(commentKey);
    assert.equal(retrying.status, 'retrying');
    assert.equal(retrying.tries, 1);
    assert.equal(world.bus.ready('effect-queue'), 0);
    assert.equal(world.bus.size('effect-queue'), 1);
    assert.equal(
      world.jira.mutationsOf('comment').filter((comment) => comment.issueKey === hung.childIssueKey).length,
      0,
    );
    const during429 = await world.invoke('get-run-status', { runId: planned.runId });
    assert.deepEqual(during429.run.budget.chaos, { injected: 3, healed: 2, duplicateWrites: 0 });

    // The injected 429 sends Retry-After: 1, the fault default. The queue
    // waits that long. RETRY_BASE_SECONDS (5) is the backoff used only when
    // the header is missing. One millisecond early, the comment is still held.
    world.clock.advance(1000 - 1);
    assert.equal(world.bus.ready('effect-queue'), 0);
    world.clock.advance(1);
    assert.equal(world.bus.ready('effect-queue'), 1);
    await world.drain();

    const finished = await world.store.getRun(planned.runId);
    assert.equal(finished.status, 'done');
    const status = await world.invoke('get-run-status', { runId: planned.runId });
    assert.equal(status.run.status, 'done');
    assert.deepEqual(status.run.budget.chaos, { injected: 3, healed: 3, duplicateWrites: 0 });
    assert.deepEqual(finished.budget.chaos, status.run.budget.chaos);

    const steps = await world.store.listSteps(planned.runId);
    const step = steps.find((item) => item.stepId === stepId);
    assert.equal(step.status, 'done');
    assert.equal(step.attempt, 1);
    assert.equal(step.childIssueKey, hung.childIssueKey);
    const appliedComment = await world.store.getEffect(commentKey);
    assert.equal(appliedComment.status, 'applied');
    assert.equal(appliedComment.tries, 2);
    assert.equal(typeof appliedComment.result.commentId, 'string');
    assert.equal((await world.store.getEffect(childKey)).tries, 1);

    const events = await world.store.listEventsByRun(planned.runId);
    const retried = events.filter((event) => event.kind === 'step.retried' && event.stepId === stepId);
    assert.equal(retried.length, 1);
    assert.equal(retried[0].detail.attempt, 1);
    const selfHeal = events.filter((event) => event.kind === 'watchdog.self-heal' && event.stepId === stepId);
    assert.equal(selfHeal.length, 1);

    assertOneChildPerWorkStep(world, steps);
    assertCommentLedger(world, DEMO_KEYS.refundsEpic, { memory: 1, waves: 1 });
    assert.equal(world.jira.mutationsOf('createIssue').length, 1);
    assert.equal(world.bus.size('effect-queue'), 0);
    assert.equal(world.bus.size('step-queue'), 0);

    const panel = await loadRun(planned.runId);
    assert.deepEqual(panel.chaos, status.run.budget.chaos);
    assert.equal(hasChaosActivity(panel.chaos), true);
    assert.equal(chaosSummary(panel.chaos), '3 injected, 3 healed, 0 duplicate writes');
    // The duplicate child-issue delivery is the one dedupe. The comment is
    // the one retry (tries 2). Both surfaces read the same object. The
    // dedupe tally was flushed on the chaos heal write, so it is on the row.
    assert.equal(hasEffectMetrics(panel.effectMetrics), true);
    assert.equal(panel.effectMetrics.deduped, 1);
    assert.equal(panel.effectMetrics.retried, 1);
    assert.deepEqual(status.run.effectMetrics, panel.effectMetrics);
    assert.equal(finished.budget.effects.deduped, 1);
    assert.equal(effectMetricsSummary(panel.effectMetrics), panel.effectMetrics.applied + ' applied, 1 deduped, 1 retried');
    assert.equal(world.llm.calls.length, 0);
    assert.deepEqual(world.fetches, []);
    assertWithinBudget(world.sdk, 'chaos-proof');
  } finally {
    await world.close();
  }
});

testSerial('a 429 Retry-After is waited out and the effect counters match', async () => {
  // One research step. The child-issue key is duplicated. The research
  // comment returns one 429 whose Retry-After is 30 seconds, longer than
  // the 5 second backoff. The gate is open so the duplicate can ride on
  // the chaos heal write. No live Jira call.
  const retryAfterSeconds = 30;
  const world = await createWorld({
    env: {
      [FAULT_INJECTION_ENV]: 'simulation',
      [SIMULATION_ENV]: '1',
    },
  });
  try {
    const planned = await world.invoke('plan-split', {
      epicKey: DEMO_KEYS.refundsEpic,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
      ],
    });
    assert.equal(planned.ok, true, planned.error);
    const stepId = planned.steps[0].stepId;
    const childKey = requestKeyFor({
      runId: planned.runId,
      stepId,
      kind: 'createIssue',
      discriminator: 'child-issue',
    });
    const commentKey = requestKeyFor({
      runId: planned.runId,
      stepId,
      kind: 'comment',
      discriminator: 'research-comment',
    });
    assert.equal(injectFault({
      type: 'duplicate-effect',
      requestKey: childKey,
    }, world.env).armed, true);
    assert.equal(injectFault({
      type: 'jira-429',
      requestKey: commentKey,
      retryAfterSeconds,
    }, world.env).armed, true);

    const dispatched = await world.invoke('dispatch-run', { runId: planned.runId });
    assert.equal(dispatched.ok, true, dispatched.error);
    await world.drain();

    const retrying = await world.store.getEffect(commentKey);
    assert.equal(retrying.status, 'retrying');
    assert.equal(retrying.tries, 1);
    assert.equal(world.bus.ready('effect-queue'), 0);
    assert.equal(world.bus.size('effect-queue'), 1);
    const during = await world.invoke('get-run-status', { runId: planned.runId });
    assert.equal(during.run.effectMetrics.retried, 1);
    assert.equal(during.run.effectMetrics.deduped, 1);
    assert.equal((await world.store.getRun(planned.runId)).budget.effects.deduped, 1);

    // Five seconds is the backoff. The header said 30, so the comment is
    // still held and Jira has not taken it.
    world.clock.advance(RETRY_BASE_SECONDS * 1000);
    await world.drain();
    assert.equal((await world.store.getEffect(commentKey)).status, 'retrying');
    assert.equal(world.bus.ready('effect-queue'), 0);
    assert.equal(
      world.jira.mutationsOf('comment').filter((comment) => comment.issueKey !== DEMO_KEYS.refundsEpic).length,
      0,
    );

    world.clock.advance((retryAfterSeconds - RETRY_BASE_SECONDS) * 1000 - 1);
    assert.equal(world.bus.ready('effect-queue'), 0);
    world.clock.advance(1);
    assert.equal(world.bus.ready('effect-queue'), 1);
    await world.drain();

    const finished = await world.store.getRun(planned.runId);
    assert.equal(finished.status, 'done');
    const appliedComment = await world.store.getEffect(commentKey);
    assert.equal(appliedComment.status, 'applied');
    assert.equal(appliedComment.tries, 2);
    assert.equal((await world.store.getEffect(childKey)).tries, 1);
    assert.equal(world.jira.mutationsOf('createIssue').length, 1);

    const status = await world.invoke('get-run-status', { runId: planned.runId });
    const rows = await world.store.listEffectsByRun(planned.runId);
    assert.equal(status.run.effectMetrics.applied, rows.filter((row) => row.status === 'applied').length);
    assert.equal(status.run.effectMetrics.retried, 1);
    assert.equal(status.run.effectMetrics.deduped, 1);
    assert.deepEqual(status.run.budget.chaos, { injected: 2, healed: 2, duplicateWrites: 0 });
    assert.equal(finished.budget.effects.deduped, 1);
    const panel = await loadRun(planned.runId);
    assert.deepEqual(panel.effectMetrics, status.run.effectMetrics);
    assert.equal(hasEffectMetrics(panel.effectMetrics), true);
    assert.equal(
      effectMetricsSummary(panel.effectMetrics),
      `${panel.effectMetrics.applied} applied, 1 deduped, 1 retried`,
    );

    // An ordinary redelivery is not a chaos heal. It must not write KVS.
    // The same process still counts the drop. The stored tally stays 1
    // until some later budget write, which this path does not do.
    const writesBefore = world.sdk.usage().writes;
    await effectApplierHandler({ body: { requestKey: childKey } });
    assert.equal(world.sdk.usage().writes, writesBefore);
    assert.equal(world.jira.mutationsOf('createIssue').length, 1);
    const afterDrop = await world.invoke('get-run-status', { runId: planned.runId });
    assert.equal(afterDrop.run.effectMetrics.deduped, 2);
    assert.equal(afterDrop.run.effectMetrics.applied, status.run.effectMetrics.applied);
    assert.equal(afterDrop.run.effectMetrics.retried, 1);
    assert.equal((await world.store.getRun(planned.runId)).budget.effects.deduped, 1);
    const panelAfter = await loadRun(planned.runId);
    assert.deepEqual(panelAfter.effectMetrics, afterDrop.run.effectMetrics);
    assert.equal(world.llm.calls.length, 0);
    assert.deepEqual(world.fetches, []);
    assertWithinBudget(world.sdk, 'effect-throughput');
  } finally {
    await world.close();
  }
});

testSerial('two comments for one child are one Jira write and undo removes that comment', async () => {
  // The worker returns two comment effects for its own child: the output
  // and a status note. They share the step completion, so they must land
  // as one POST. The Epic wave report and the memory comment are different
  // issues and different times, and they stay separate writes.
  const world = await createWorld();
  try {
    const epicKey = DEMO_KEYS.refundsEpic;
    const seedBoard = cloneIssueMap(world.jira);
    registerWorkerType('note-pair', async (step) => {
      const target = step.childIssueKey
        ? { issueKey: step.childIssueKey }
        : { childOfStepId: step.stepId };
      return {
        output: { summary: 'paired notes for the refund spec' },
        effects: [
          {
            kind: 'comment',
            discriminator: 'worker-output',
            payload: {
              ...target,
              bodyText: 'WORKER-OUTPUT the refund notes',
              bodyAdf: doc([
                paragraph([textNode('WORKER-OUTPUT')]),
                paragraph([textNode('the refund notes')]),
              ]),
            },
          },
          {
            kind: 'comment',
            discriminator: 'status-note',
            payload: {
              ...target,
              bodyText: 'STATUS-NOTE the step finished',
              bodyAdf: doc([
                paragraph([textNode('STATUS-NOTE')]),
                paragraph([textNode('the step finished')]),
              ]),
            },
          },
        ],
      };
    });

    const planned = await world.invoke('plan-split', {
      epicKey,
      projectKey: DEMO_KEYS.projectKey,
      goal: GOAL,
      steps: [
        {
          title: 'Pair the refund notes',
          workerType: 'note-pair',
          input: 'refunds',
          dependsOn: [],
        },
      ],
    });
    assert.equal(planned.ok, true, planned.error);
    assert.equal(planned.steps.length, 1);
    assert.equal(planned.steps[0].workerType, 'note-pair');
    assert.equal(planned.blastRadius.gate.insert, false);
    const stepId = planned.steps[0].stepId;
    const batchKey = requestKeyFor({
      runId: planned.runId,
      stepId,
      kind: 'comment',
      discriminator: 'batch:status-note+worker-output',
    });

    const dispatched = await world.invoke('dispatch-run', { runId: planned.runId });
    assert.equal(dispatched.ok, true, dispatched.error);
    await world.drain();

    const finished = await world.store.getRun(planned.runId);
    assert.equal(finished.status, 'done');
    const steps = await world.store.listSteps(planned.runId);
    const step = steps.find((item) => item.stepId === stepId);
    assert.equal(step.status, 'done');
    assert.equal(typeof step.childIssueKey, 'string');
    assertOneChildPerWorkStep(world, steps);
    assertCommentLedger(world, epicKey, { memory: 1, waves: 1 });
    await assertChildEffectsOnce(world, planned.runId, steps, epicKey);

    const childPosts = world.jira.mutationsOf('comment').filter((comment) => (
      comment.issueKey === step.childIssueKey
    ));
    assert.equal(childPosts.length, 1, 'the child received one comment POST');
    assert.match(childPosts[0].bodyText, /WORKER-OUTPUT/);
    assert.match(childPosts[0].bodyText, /the refund notes/);
    assert.match(childPosts[0].bodyText, /STATUS-NOTE/);
    assert.match(childPosts[0].bodyText, /the step finished/);

    const batched = await world.store.getEffect(batchKey);
    assert.equal(batched.status, 'applied');
    assert.equal(batched.tries, 1);
    assert.equal(batched.result.commentId, childPosts[0].commentId);
    assert.equal(batched.payload.issueKey, step.childIssueKey);
    assert.deepEqual(batched.payload.batchedFrom, ['worker-output', 'status-note']);
    assert.match(batched.payload.bodyText, /WORKER-OUTPUT the refund notes/);
    assert.match(batched.payload.bodyText, /STATUS-NOTE the step finished/);
    for (const discriminator of ['worker-output', 'status-note']) {
      const partKey = requestKeyFor({
        runId: planned.runId,
        stepId,
        kind: 'comment',
        discriminator,
      });
      assert.equal(await world.store.getEffect(partKey), null, discriminator);
    }

    const epicPosts = world.jira.mutationsOf('comment').filter((comment) => (
      comment.issueKey === epicKey
    ));
    assert.equal(epicPosts.length, 2);
    assert.equal(epicPosts.some((comment) => comment.bodyText.startsWith('[Conductor wave]')), true);
    assert.equal(epicPosts.some((comment) => comment.bodyText.startsWith('[Conductor memory]')), true);

    const callsBefore = world.jira.calls.length;
    const mutationsBefore = world.jira.mutations.length;
    const writesBefore = world.sdk.usage().writes;
    await effectApplierHandler({ body: { requestKey: batchKey } });
    assert.equal(world.jira.calls.length, callsBefore, 'redelivered comment called Jira');
    assert.equal(world.jira.mutations.length, mutationsBefore, 'redelivered comment mutated Jira');
    assert.equal(world.sdk.usage().writes, writesBefore, 'redelivered comment wrote KVS');
    assert.equal((await world.store.getEffect(batchKey)).tries, 1);

    const jiraWritesBeforeReplay = jiraWriteCount(world);
    const writesBeforeReplay = world.sdk.usage().writes;
    const replay = await world.invoke('replay-run', { runId: planned.runId });
    assert.equal(replay.ok, true, replay.error);
    assert.equal(replay.duplicateWrites, 0);
    assert.equal(jiraWriteCount(world), jiraWritesBeforeReplay);
    assert.equal(world.sdk.usage().writes, writesBeforeReplay, 'replay wrote KVS');
    const replayed = replay.effects.find((effect) => effect.requestKey === batchKey);
    assert.equal(replayed.verdict, 'already-applied-skipped');
    assert.equal(replay.effects.some((effect) => effect.verdict === 'would-apply'), false);

    const forward = await world.store.listEffectsByRun(planned.runId);
    const plan = planCompensations(forward);
    assert.deepEqual(plan.cannotUndo.map((item) => item.reason), []);
    const removals = plan.compensations.filter((item) => item.kind === 'recordRemovedComment');
    const childRemoval = removals.find((item) => item.payload.commentId === childPosts[0].commentId);
    assert.ok(childRemoval, 'undo did not plan a delete for the batched comment');
    assert.equal(childRemoval.payload.issueKey, step.childIssueKey);
    const close = plan.compensations.find((item) => (
      item.kind === 'closeIssue' && item.payload.issueKey === step.childIssueKey
    ));
    assert.ok(close, 'undo did not plan to close the child');
    assert.ok(close.dependsOnKeys.includes(childRemoval.requestKey));

    const enqueued = await enqueueCompensations(plan);
    assert.ok(enqueued.length > 0);
    assert.ok(enqueued.every((item) => item.created === true));
    await world.drain();

    /** @type {string[]} */
    const residue = [];
    for (const [key, issue] of world.jira.issues) {
      if (seedBoard.has(key)) {
        assert.deepEqual(JSON.parse(JSON.stringify(issue)), seedBoard.get(key), key);
        assert.equal(commentCount(issue), 0, `${key} still has a comment`);
      } else {
        residue.push(key);
        assert.equal(isRollbackResidue(issue), true, `${key} was not closed and labelled`);
        assert.equal(commentCount(issue), 0, `${key} still has a comment`);
      }
    }
    assert.deepEqual(residue, [step.childIssueKey]);

    const callsBeforeUndo = world.jira.calls.length;
    const mutationsBeforeUndo = world.jira.mutations.length;
    const writesBeforeUndo = world.sdk.usage().writes;
    await effectApplierHandler({ body: { requestKey: childRemoval.requestKey } });
    assert.equal(world.jira.calls.length, callsBeforeUndo, 'redelivered undo called Jira');
    assert.equal(world.jira.mutations.length, mutationsBeforeUndo, 'redelivered undo mutated Jira');
    assert.equal(world.sdk.usage().writes, writesBeforeUndo, 'redelivered undo wrote KVS');

    assert.equal(world.llm.calls.length, 0);
    assert.deepEqual(world.fetches, []);
    assertWithinBudget(world.sdk, 'comment-batching');
  } finally {
    await world.close();
  }
});

testSerial('a reset fault schedule starts the next id at fault-1', async () => {
  // The id counter is process memory, the same way the armed list is.
  // This case runs in the serial queue, in whatever order the harness
  // picked, and the previous scenario's close() must already have left
  // the counter at 0. Arming here must not change the next scenario's
  // first id either.
  const gate = {
    [FAULT_INJECTION_ENV]: 'simulation',
    [SIMULATION_ENV]: '1',
  };
  assert.equal(faultInjectionResidue(), null);
  try {
    const first = injectFault({ type: 'kill-worker' }, gate);
    const second = injectFault({ type: 'duplicate-effect' }, gate);
    assert.equal(first.armed, true);
    assert.equal(second.armed, true);
    if (first.armed) assert.equal(first.id, 'fault-1');
    if (second.armed) assert.equal(second.id, 'fault-2');
    assert.equal(faultInjectionResidue(), '2 armed, id counter 2');
  } finally {
    resetFaultInjection();
  }
  assert.equal(faultInjectionResidue(), null);
});

// Register the queued scenarios now that every testSerial call has run.
// The headroom test waits on the same chain, so its table includes a
// scenario that failed its own cap check.
const scenariosFinished = startSerialScenarios();

test('KVS headroom report', async () => {
  await scenariosFinished;
  const rows = scenarioHeadroom();
  const text = formatHeadroomReport(rows, { order: scenarioOrderDescription() });
  console.log(`\n${text}`);
  for (const warning of headroomWarnings(rows)) {
    console.warn(warning);
  }
  const failures = headroomFailures(rows);
  assert.equal(
    failures.length,
    0,
    failures.length === 0
      ? text
      : `${failures.map((row) => `${row.name} ${row.status}`).join(', ')}\n${text}`,
  );
});
