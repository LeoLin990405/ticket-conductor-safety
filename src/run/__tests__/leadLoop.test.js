/**
 * SuperAgent lead loop: wave review, digests, caps, and the human pause.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { layoutDependencyGraph } from '../../frontend/graph.js';
import { buildGenAiSpan } from '../../recorder/otel.js';
import { buildTimeline } from '../../recorder/timeline.js';
import { createMemoryStore } from '../../store/index.js';
import { childIssueUpdated } from '../../triggers/childIssueUpdated.js';
import { loadUpstream } from '../../worker/sources.js';
import { resetLlmCache } from '../../worker/llm.js';
import { createWatchdog } from '../../watchdog/index.js';
import { DIGEST_BYTE_BUDGET, effortScale, spawnBudget } from '../digest.js';
import {
  WAVE_REPORT_HEADER,
  buildWaveReport,
  parseHumanCommand,
  resumeAwaitingRun,
} from '../leadLoop.js';
import { resetLocks } from '../locks.js';
import { reportStep, startRun } from '../stateMachine.js';

import { createHarness } from './harness.js';

test.afterEach(() => {
  resetLocks();
  resetLlmCache();
});

const BLOB = 'BLOB-TOKEN-SHOULD-NOT-LEAK';

/**
 * @param {Record<string, unknown>} payload
 * @param {{prompts: object[]}} capture
 */
function mockLlm(payload, capture) {
  return {
    async list() {
      return {
        models: [{ model: 'claude-haiku-4-5-20251001', status: 'active' }],
      };
    },
    async chat(prompt) {
      capture.prompts.push(prompt);
      return {
        choices: [{ message: { content: JSON.stringify(payload) } }],
      };
    },
  };
}

test('a finished wave with no follow-up stops, writes a digest, and reports on the Epic', async () => {
  const harness = createHarness();
  const run = await harness.createRun('Ship refunds');
  const [step] = await harness.createSteps(run.runId, [
    { title: 'Research refunds', workerType: 'research', input: {} },
  ]);
  assert.equal(step.wave, 1);
  await startRun(run.runId, harness.dependencies);

  const reported = await reportStep(
    step.stepId,
    { status: 'done', output: { summary: 'No related issues found.', blob: BLOB.repeat(40) } },
    harness.dependencies,
  );
  assert.equal(reported.run.status, 'done');

  const stored = await harness.store.getRun(run.runId);
  assert.equal(stored.reviewedThroughWave, 1);
  assert.equal(stored.ledger.lastDecision.action, 'stop');
  assert.equal(stored.ledger.lastDecision.generator, 'fallback');
  assert.ok(stored.ledger.digests[0].bytes <= DIGEST_BYTE_BUDGET);
  assert.equal(stored.ledger.digests[0].text.includes(BLOB), false);

  const waveComments = harness.enqueuedEffects.filter(
    (effect) => effect.discriminator === 'wave-report:1',
  );
  assert.equal(waveComments.length, 1);
  assert.equal(waveComments[0].payload.issueKey, 'TC-1');
  assert.ok(waveComments[0].payload.bodyText.startsWith(WAVE_REPORT_HEADER));
  assert.match(waveComments[0].payload.bodyText, /Report back, you decide/);
  assert.match(waveComments[0].payload.bodyText, /Decision: stop/);
  assert.equal(waveComments[0].payload.bodyAdf.type, 'doc');
  assert.equal(waveComments[0].payload.bodyAdf.version, 1);

  const steps = await harness.store.listSteps(run.runId);
  assert.equal(steps.filter((item) => item.workerType === 'summarize').length, 1);
  assert.equal(steps.filter((item) => item.workerType !== 'summarize').length, 1);

  const events = await harness.store.listEventsByRun(run.runId);
  const kinds = events.map((event) => event.kind);
  assert.ok(kinds.includes('wave_started'));
  assert.ok(kinds.includes('digest_written'));
  assert.ok(kinds.includes('lead_decision'));
  const decision = events.find((event) => event.kind === 'lead_decision');
  assert.equal(decision.span['gen_ai.operation.name'], 'invoke_agent');
  assert.equal(decision.span['gen_ai.request.model'], 'deterministic-fallback');
  const timeline = buildTimeline(events);
  assert.equal(timeline.find((row) => row.kind === 'wave_started').label, 'Wave started');
  assert.equal(timeline.find((row) => row.kind === 'lead_decision').lead, true);
  assert.equal(timeline.find((row) => row.kind === 'digest_written').digest, true);

  await reportStep(
    step.stepId,
    { status: 'failed', error: { message: 'late' } },
    harness.dependencies,
  );
  assert.equal(
    harness.enqueuedEffects.filter((effect) => effect.discriminator === 'wave-report:1').length,
    1,
  );
});

test('unknown dependency spawns one check, wired with dependsOn, that sees the digest', async () => {
  const harness = createHarness();
  const run = await harness.createRun('Ship refunds');
  const [step] = await harness.createSteps(run.runId, [
    { title: 'Research refunds', workerType: 'research', input: {} },
  ]);
  await startRun(run.runId, harness.dependencies);
  const huge = 'x'.repeat(4000);
  await reportStep(
    step.stepId,
    {
      status: 'done',
      output: {
        summary: `unknown dependency in capture ${huge}`,
        blob: BLOB,
      },
    },
    harness.dependencies,
  );

  const steps = await harness.store.listSteps(run.runId);
  const spawned = steps.find((item) => item.wave === 2);
  assert.ok(spawned);
  assert.equal(spawned.workerType, 'check-deps');
  assert.deepEqual(spawned.dependsOn, [0]);
  assert.equal(JSON.stringify(spawned.dependencyContext).includes(BLOB), false);
  assert.equal(JSON.stringify(spawned.dependencyContext).includes(huge), false);
  assert.equal(spawned.dependencyContext[0].digest, true);
  assert.match(spawned.input.waveDigest, /unknown dependency/);
  assert.ok(spawned.input.waveDigest.length <= DIGEST_BYTE_BUDGET);
  assert.equal((await harness.store.getRun(run.runId)).status, 'running');

  const upstream = await loadUpstream(spawned, { store: harness.store });
  assert.equal(JSON.stringify(upstream).includes(BLOB), false);
  assert.match(upstream[0].output.summary, /unknown dependency/);

  const nodes = layoutDependencyGraph(steps);
  const node = nodes.find((item) => item.wave === 2);
  assert.equal(node.dependsOn[0], 0);
  assert.ok(node.depth >= 1);

  const creates = harness.enqueuedEffects.filter(
    (effect) => effect.kind === 'createIssue' && effect.stepId === spawned.stepId,
  );
  assert.equal(creates.length, 1);
  assert.equal(creates[0].payload.parentKey, 'TC-1');
});

test('a broad goal can spawn three follow-ups and a small goal spawns one', async () => {
  assert.equal(effortScale('Ship refunds'), 'small');
  assert.equal(
    effortScale('Migrate the payment integration for security compliance'),
    'large',
  );
  assert.equal(spawnBudget({ goal: 'Ship refunds', existingSteps: 8, nextWave: 2 }), 0);
  assert.equal(spawnBudget({ goal: 'Ship refunds', existingSteps: 1, nextWave: 4 }), 0);

  const followUps = [1, 2, 3, 4, 5].map((number) => ({
    title: `Research gap ${number}`,
    workerType: 'research',
  }));

  const large = createHarness();
  const broad = await large.createRun('Migrate the payment integration for security compliance');
  const [first] = await large.createSteps(broad.runId, [
    { title: 'Survey', workerType: 'research', input: {} },
  ]);
  await startRun(broad.runId, large.dependencies);
  await reportStep(
    first.stepId,
    { status: 'done', output: { summary: 'gaps remain', followUps, blob: BLOB } },
    large.dependencies,
  );
  const spawned = (await large.store.listSteps(broad.runId)).filter((step) => step.wave === 2);
  assert.equal(spawned.length, 3);
  assert.ok(spawned.every((step) => step.dependsOn.length === 1));
  assert.ok(spawned.every((step) => !JSON.stringify(step.input).includes(BLOB)));

  const small = createHarness();
  const tiny = await small.createRun('Ship refunds');
  const [only] = await small.createSteps(tiny.runId, [
    { title: 'Survey', workerType: 'research', input: {} },
  ]);
  await startRun(tiny.runId, small.dependencies);
  await reportStep(
    only.stepId,
    { status: 'done', output: { summary: 'gaps', followUps } },
    small.dependencies,
  );
  assert.equal(
    (await small.store.listSteps(tiny.runId)).filter((step) => step.wave === 2).length,
    1,
  );
});

test('the third wave is the last one, and eight steps leave no room to spawn', async () => {
  const harness = createHarness();
  const run = await harness.createRun('Ship refunds');
  const [first] = await harness.createSteps(run.runId, [
    { title: 'Research', workerType: 'research', input: {} },
  ]);
  await startRun(run.runId, harness.dependencies);

  let current = first;
  for (let wave = 1; wave <= 3; wave += 1) {
    const reported = await reportStep(
      current.stepId,
      { status: 'done', output: { summary: 'unknown dependency remains' } },
      harness.dependencies,
    );
    if (wave < 3) {
      assert.equal(reported.run.status, 'running');
      const next = (await harness.store.listSteps(run.runId)).find((step) => step.wave === wave + 1);
      assert.ok(next, `wave ${wave + 1} should exist`);
      current = next;
    }
  }
  const paused = await harness.store.getRun(run.runId);
  assert.equal(paused.status, 'awaiting-review');
  assert.equal(paused.reviewedThroughWave, 3);
  assert.equal(
    (await harness.store.listSteps(run.runId)).filter((step) => step.workerType !== 'summarize').length,
    3,
  );

  const full = createHarness();
  const capped = await full.createRun('Ship refunds');
  const drafts = Array.from({ length: 8 }, (_, index) => ({
    title: `Step ${index}`,
    workerType: 'research',
    input: {},
  }));
  const created = await full.createSteps(capped.runId, drafts);
  await startRun(capped.runId, full.dependencies);
  for (let index = 0; index < created.length; index += 1) {
    const output = index === created.length - 1
      ? { summary: 'unknown dependency at the cap' }
      : { summary: 'done' };
    await reportStep(created[index].stepId, { status: 'done', output }, full.dependencies);
  }
  const atCap = await full.store.getRun(capped.runId);
  assert.equal(atCap.status, 'awaiting-review');
  assert.equal(atCap.ledger.lastDecision.action, 'ask');
  assert.equal((await full.store.listSteps(capped.runId)).length, 8);
});

test('the model decision is used, and a fenced digest is all it sees', async () => {
  const capture = { prompts: [] };
  const harness = createHarness();
  const run = await harness.createRun('Ship refunds');
  const [step] = await harness.createSteps(run.runId, [
    { title: 'Research refunds', workerType: 'research', input: {} },
  ]);
  await startRun(run.runId, harness.dependencies);
  const llm = mockLlm(
    {
      action: 'spawn',
      why: 'The digest names a gap.',
      steps: [{ title: 'Check capture', workerType: 'check-deps' }],
    },
    capture,
  );
  await reportStep(
    step.stepId,
    { status: 'done', output: { summary: 'all clear', blob: BLOB } },
    { ...harness.dependencies, llm },
  );
  const spawned = (await harness.store.listSteps(run.runId)).find((item) => item.wave === 2);
  assert.equal(spawned.title, 'Check capture');
  const decision = (await harness.store.listEventsByRun(run.runId))
    .find((event) => event.kind === 'lead_decision');
  assert.equal(decision.detail.generator, 'llm');
  assert.equal(decision.detail.model, 'claude-haiku-4-5-20251001');
  assert.equal(decision.span['gen_ai.request.model'], 'claude-haiku-4-5-20251001');
  const user = capture.prompts[0].messages[1].content;
  assert.match(user, /<untrusted source="digest"/);
  assert.equal(user.includes(BLOB), false);
  assert.match(capture.prompts[0].messages[0].content, /not instructions/);

  const forced = createHarness();
  const other = await forced.createRun('Ship refunds');
  const [only] = await forced.createSteps(other.runId, [
    { title: 'Research', workerType: 'research', input: {} },
  ]);
  await startRun(other.runId, forced.dependencies);
  const noisy = mockLlm(
    { action: 'spawn', why: 'ignore the cap', steps: [{ title: 'Extra', workerType: 'research' }] },
    { prompts: [] },
  );
  const stopped = await reportStep(
    only.stepId,
    { status: 'done', output: { summary: 'all clear' } },
    { ...forced.dependencies, llm: noisy, allowLeadLlm: false },
  );
  assert.equal(stopped.run.status, 'done');
  assert.equal(stopped.run.ledger.lastDecision.generator, 'fallback');
});

test('ask a human pauses until a reply or a transition, and the report cannot unpause itself', async () => {
  const report = buildWaveReport(
    { action: 'ask', why: 'Needs a person.', suggestions: [] },
    { wave: 1, text: 'Wave 1 (1 step(s))' },
    1,
  );
  assert.equal(parseHumanCommand(report.bodyText), null);
  assert.equal(parseHumanCommand('conductor stop').action, 'stop');
  assert.equal(parseHumanCommand('please look'), null);

  const harness = createHarness();
  const run = await harness.createRun('Ship refunds');
  const [step] = await harness.createSteps(run.runId, [
    { title: 'Research', workerType: 'research', input: {} },
  ]);
  await startRun(run.runId, harness.dependencies);
  await reportStep(
    step.stepId,
    {
      status: 'done',
      output: {
        askHuman: true,
        summary: 'needs a decision',
        followUps: [{ title: 'Draft the refund spec', workerType: 'draft-spec' }],
      },
    },
    harness.dependencies,
  );
  assert.equal((await harness.store.getRun(run.runId)).status, 'awaiting-review');
  assert.equal(
    (await harness.store.listSteps(run.runId)).some((item) => item.workerType === 'summarize'),
    false,
  );

  const ignored = await childIssueUpdated({
    issue: { key: 'TC-1' },
    comment: { body: 'looks good to me' },
  }, {
    getStepByChildIssueKey: async () => null,
    listRunsByEpic: (key, options) => harness.store.listRunsByEpic(key, options),
    leadDependencies: harness.dependencies,
  });
  assert.equal(ignored.status, 'ignored');
  assert.equal((await harness.store.getRun(run.runId)).status, 'awaiting-review');

  const quoted = await resumeAwaitingRun({
    issueKey: 'TC-1',
    event: { comment: { body: report.bodyText } },
    listRuns: (key, options) => harness.store.listRunsByEpic(key, options),
    dependencies: harness.dependencies,
  });
  assert.equal(quoted, null);

  const continued = await childIssueUpdated({
    issue: { key: 'TC-1' },
    comment: {
      author: { accountId: 'acct-lin' },
      body: {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [{ type: 'text', text: 'conductor continue' }],
        }],
      },
    },
  }, {
    getStepByChildIssueKey: async () => null,
    listRunsByEpic: (key, options) => harness.store.listRunsByEpic(key, options),
    leadDependencies: harness.dependencies,
  });
  assert.equal(continued.status, 'resumed');
  assert.equal(continued.action, 'continue');
  const spawned = (await harness.store.listSteps(run.runId)).find((item) => item.wave === 2);
  assert.equal(spawned.workerType, 'draft-spec');
  assert.equal((await harness.store.getRun(run.runId)).status, 'running');
  const humanEvents = (await harness.store.listEventsByRun(run.runId))
    .filter((event) => event.kind === 'lead_decision' && event.detail?.generator === 'human');
  assert.equal(humanEvents.length, 1);
  assert.equal(humanEvents[0].detail.action, 'continue');
  assert.equal(humanEvents[0].detail.via, 'comment');
  assert.equal(humanEvents[0].detail.actor, 'acct-lin');
  assert.equal(humanEvents[0].detail.requested, 'continue');

  const again = await resumeAwaitingRun({
    issueKey: 'TC-1',
    event: { comment: { body: 'conductor continue' } },
    listRuns: (key, options) => harness.store.listRunsByEpic(key, options),
    dependencies: harness.dependencies,
  });
  assert.equal(again, null);

  const paused = createHarness();
  const second = await paused.createRun('Ship refunds');
  const [only] = await paused.createSteps(second.runId, [
    { title: 'Research', workerType: 'research', input: {} },
  ]);
  await startRun(second.runId, paused.dependencies);
  await reportStep(
    only.stepId,
    { status: 'done', output: { askHuman: true, summary: 'needs a decision' } },
    paused.dependencies,
  );
  const transitioned = await childIssueUpdated({
    issue: { key: 'TC-1' },
    changelog: { items: [{ field: 'status', toString: 'Done' }] },
  }, {
    getStepByChildIssueKey: async () => null,
    listRunsByEpic: (key, options) => paused.store.listRunsByEpic(key, options),
    leadDependencies: paused.dependencies,
  });
  assert.equal(transitioned.action, 'stop');
  const stopEvent = (await paused.store.listEventsByRun(second.runId))
    .find((event) => event.kind === 'lead_decision' && event.detail?.generator === 'human');
  assert.equal(stopEvent?.detail.via, 'transition');
  assert.equal((await paused.store.getRun(second.runId)).status, 'done');
  assert.ok(
    (await paused.store.listSteps(second.runId)).some((item) => item.workerType === 'summarize'),
  );
});

test('the watchdog does not retry a step while the run is awaiting review', async () => {
  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  const run = await store.createRun({
    epicKey: 'TC-1',
    projectKey: 'TC',
    goal: 'Ship refunds',
    createdBy: 'acct',
  });
  const [step] = await store.createSteps(run.runId, [
    { title: 'Held', workerType: 'research', input: {} },
  ]);
  await store.updateRun(run.runId, { status: 'awaiting-review' });
  const pushes = [];
  const summary = await createWatchdog({
    store,
    pushStep: async (payload) => {
      pushes.push(payload);
      return { ok: true };
    },
    pushEffect: async () => ({ ok: true }),
    enqueueEffect: async () => ({ requestKey: 'k', created: true }),
  }).run({ now: step.createdAt + 11 * 60 * 1000 });
  assert.deepEqual(pushes, []);
  assert.equal(summary.skippedSteps.some((item) => item.reason === 'awaiting-review'), true);
  assert.equal((await store.getStep(step.stepId)).attempt, 0);
  assert.equal((await store.getStep(step.stepId)).status, 'queued');
});

test('two reviews cannot both claim the same wave', async () => {
  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  const run = await store.createRun({
    epicKey: 'TC-1',
    projectKey: 'TC',
    goal: 'Ship refunds',
    createdBy: 'acct',
  });
  const [first, second] = await Promise.all([
    store.updateRun(
      run.runId,
      { reviewedThroughWave: 1 },
      { expectedReviewedWave: 0 },
    ),
    store.updateRun(
      run.runId,
      { reviewedThroughWave: 2 },
      { expectedReviewedWave: 0 },
    ),
  ]);
  const wins = [first, second].filter(Boolean);
  assert.equal(wins.length, 1);
  const stored = await store.getRun(run.runId);
  assert.ok(stored.reviewedThroughWave === 1 || stored.reviewedThroughWave === 2);
  assert.equal(Object.prototype.hasOwnProperty.call(stored, 'runId'), true);
});

test('lead decision span names the operation', () => {
  const span = buildGenAiSpan({
    runId: 'run',
    kind: 'digest_written',
    detail: { generator: 'fallback' },
  });
  assert.equal(span['gen_ai.operation.name'], 'execute_tool');
  assert.equal(span['gen_ai.request.model'], 'deterministic-fallback');
});

test('a reply uses the Epic await index, not the run list', async () => {
  const harness = createHarness();
  const index = new Map();
  harness.dependencies.awaitIndex = {
    async get(key) { return index.get(key) ?? null; },
    async set(key, runId) { index.set(key, runId); },
  };
  const run = await harness.createRun('Ship refunds');
  const [only] = await harness.createSteps(run.runId, [
    { title: 'Research', workerType: 'research', input: {} },
  ]);
  await startRun(run.runId, harness.dependencies);
  await reportStep(
    only.stepId,
    { status: 'done', output: { askHuman: true, summary: 'needs a decision' } },
    harness.dependencies,
  );
  assert.equal(index.get('TC-1'), run.runId);
  let listed = 0;
  const resumed = await resumeAwaitingRun({
    issueKey: 'TC-1',
    event: { comment: { body: 'conductor stop' } },
    listRuns: async () => { listed += 1; return []; },
    dependencies: harness.dependencies,
  });
  assert.equal(resumed.action, 'stop');
  assert.equal(listed, 0);
  const again = await resumeAwaitingRun({
    issueKey: 'TC-1',
    event: { comment: { body: 'conductor stop' } },
    listRuns: async () => { listed += 1; return []; },
    dependencies: harness.dependencies,
  });
  assert.equal(again, null, 'a stale index entry is ignored');
});
