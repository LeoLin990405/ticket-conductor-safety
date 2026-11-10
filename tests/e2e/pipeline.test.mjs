/**
 * End-to-end coverage for the modules that are already on main:
 * WP1 storage, WP2 effects, WP3 workers and the run state machine, WP4
 * watchdog, WP6 memory.
 *
 * WP5 (Rovo action handlers), WP8 (the issue panel) and WP9 (manifest, CI,
 * package.json) are intentionally not imported. Where a scenario needs
 * `planSplit` or `dispatchRun`, the test is skipped with a TODO instead of
 * reimplementing those handlers here.
 *
 * The Forge boundaries are fakes (`@forge/kvs`, `@forge/events`, Jira REST).
 * Nothing in this file deploys or calls a live site.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { effectApplierHandler } from '../../src/effects/index.js';
import { recall, record, writeBack } from '../../src/memory/index.js';
import { startRun } from '../../src/run/stateMachine.js';
import { registerWorkerType, stepWorkerHandler } from '../../src/worker/index.js';
import { STALE_EFFECT_MS } from '../../src/watchdog/constants.js';

import {
  assertNoUnapprovedEffects,
  createWorld,
  DEMO_KEYS,
  dispatchAndDrain,
  INJECTION_TOKEN,
  loadSeed,
  MEMORY_COMMENT_HEADER,
  PROMPT_INJECTION,
  RETRY_DEADLINE_MS,
  savePlan,
  STEP_DEADLINE_MS,
  testSerial,
  WATCHDOG_COMMENT_HEADER,
} from './harness.mjs';

const seed = loadSeed();

/**
 * @param {object[]} steps
 * @returns {string[]}
 */
function titlesOf(steps) {
  return steps.map((step) => step.title);
}

test(
  'scenario 03: a second enqueueEffect still pushes the same requestKey',
  {
    skip:
      'TODO: scenario 03 says a duplicate enqueueEffect still pushes ' +
      '{body:{requestKey}} onto effect-queue. WP2 enqueueEffect pushes only ' +
      'when putEffectIfAbsent creates the row (src/effects/index.js), and its ' +
      'unit test locks a single queue message. One Jira mutation either way; ' +
      'at-least-once replay of a message that was pushed is covered below. ' +
      'Not changed here: reversing it would contradict that module\'s tests.',
  },
  () => {},
);

testSerial('happy path: a seeded plan drains to done with one child issue per step', async () => {
  const world = await createWorld();
  try {
    const planned = seed.demo.planSteps.map((step) => ({
      title: step.title,
      workerType: step.workerType,
      input: step.input,
    }));
    const { run, steps } = await savePlan(world, {
      goal: seed.demo.primaryGoal,
      steps: planned,
    });

    // Saving a plan must not touch Jira or either queue. Dispatch is separate.
    assert.equal(run.status, 'planning');
    assert.equal(world.jira.calls.length, 0);
    assert.equal(world.bus.size('step-queue'), 0);
    assert.equal(world.bus.size('effect-queue'), 0);
    assert.equal(steps.length, planned.length);
    assert.ok(steps.every((step) => step.status === 'queued' && step.attempt === 0));
    assert.ok(steps.every((step) => step.deadlineAt === undefined));

    const { started, stepResults } = await dispatchAndDrain(world, run.runId);
    assert.equal(started.status, 'running');
    assert.ok(stepResults.every((result) => result.status === 'done'));

    const finished = await world.store.getRun(run.runId);
    assert.equal(finished.status, 'done');
    assert.match(String(finished.summary), /completed 6 step\(s\)/);

    const storedSteps = await world.store.listSteps(run.runId);
    assert.equal(storedSteps.length, planned.length + 1);
    assert.ok(storedSteps.every((step) => step.status === 'done'));
    const summarize = storedSteps.find((step) => step.workerType === 'summarize');
    assert.equal(summarize.input.auto, true);
    assert.equal(summarize.idx, planned.length);
    assert.equal(new Set(storedSteps.map((step) => step.idx)).size, storedSteps.length);

    assertNoUnapprovedEffects(world, {
      epicKey: DEMO_KEYS.refundsEpic,
      plannedTitles: titlesOf(planned),
    });

    // Idempotent effect replay: deliver every applied createIssue again,
    // including two concurrent deliveries of the same key.
    const applied = await world.store.listEffectsByStatus('applied');
    const creates = applied.filter((effect) => effect.kind === 'createIssue');
    assert.equal(creates.length, planned.length);
    const issueCount = world.jira.mutationsOf('createIssue').length;
    await Promise.all(
      creates.flatMap((effect) => [
        effectApplierHandler({ body: { requestKey: effect.requestKey } }),
        effectApplierHandler({ body: { requestKey: effect.requestKey } }),
      ]),
    );
    assert.equal(world.jira.mutationsOf('createIssue').length, issueCount);
    for (const effect of creates) {
      const reread = await world.store.getEffect(effect.requestKey);
      assert.equal(reread.status, 'applied');
      assert.equal(reread.tries, effect.tries);
      assert.equal(reread.result.issueKey, effect.result.issueKey);
    }

    // A second startRun is a no-op once the run has left planning. This is
    // the state-machine half of scenario 03. The idem:dispatch KVS key is WP5.
    await dispatchAndDrain(world, run.runId);
    assert.equal(world.jira.mutationsOf('createIssue').length, issueCount);
    assert.equal((await world.store.listSteps(run.runId)).length, planned.length + 1);
    const epicComments = world.jira
      .mutationsOf('comment')
      .filter((comment) => comment.issueKey === DEMO_KEYS.refundsEpic);
    const memoryComments = epicComments.filter((comment) =>
      comment.bodyText.startsWith(MEMORY_COMMENT_HEADER),
    );
    const waveComments = epicComments.filter((comment) =>
      comment.bodyText.startsWith('[Conductor wave]'),
    );
    assert.equal(memoryComments.length, 1);
    assert.ok(waveComments.length >= 1);
  } finally {
    await world.close();
  }
});

testSerial('concurrent duplicate enqueue creates one effect and one Jira issue', async () => {
  const world = await createWorld();
  try {
    const { run, steps } = await savePlan(world, {
      goal: 'Ship payment refunds',
      steps: [
        {
          title: 'Draft the refund API',
          workerType: 'draft-spec',
          input: 'The idempotency key is the payment id.',
        },
      ],
    });
    const input = {
      runId: run.runId,
      stepId: steps[0].stepId,
      kind: 'createIssue',
      payload: {
        projectKey: 'PAY',
        parentKey: DEMO_KEYS.refundsEpic,
        summary: 'Draft the refund API',
        description: 'Created once, even if enqueue races.',
        issueType: 'Sub-task',
      },
      discriminator: 'child-issue',
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () => world.dependencies.enqueueEffect(input)),
    );
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(new Set(results.map((result) => result.requestKey)).size, 1);
    // WP2 pushes on the insert only, so eight callers still produce one message.
    assert.equal(world.bus.size('effect-queue'), 1);

    await Promise.all([
      effectApplierHandler(world.bus.snapshot('effect-queue')[0]),
      effectApplierHandler(world.bus.snapshot('effect-queue')[0]),
      effectApplierHandler(world.bus.snapshot('effect-queue')[0]),
    ]);
    // The message is still queued; drain it (the apply above already ran).
    await world.drainEffects();

    assert.equal(world.jira.mutationsOf('createIssue').length, 1);
    const step = await world.store.getStep(steps[0].stepId);
    assert.equal(step.childIssueKey, world.jira.mutationsOf('createIssue')[0].issueKey);
    const effect = await world.store.getEffect(results[0].requestKey);
    assert.equal(effect.status, 'applied');
    assert.equal(effect.tries, 1);
  } finally {
    await world.close();
  }
});

testSerial('a Jira 500 is retried and the successful attempt creates one issue', async () => {
  const world = await createWorld();
  try {
    const { run, steps } = await savePlan(world, {
      goal: 'Ship payment refunds',
      steps: [
        { title: 'Draft the ledger rule', workerType: 'draft-spec', input: 'one line' },
      ],
    });
    world.jira.failNext(
      2,
      (call) => call.method === 'POST' && call.pathname === '/rest/api/3/issue',
    );
    const { requestKey } = await world.dependencies.enqueueEffect({
      runId: run.runId,
      stepId: steps[0].stepId,
      kind: 'createIssue',
      payload: {
        projectKey: 'PAY',
        parentKey: DEMO_KEYS.refundsEpic,
        summary: 'Draft the ledger rule',
        description: 'Retry me.',
        issueType: 'Sub-task',
      },
      discriminator: 'child-issue',
    });

    await world.drainEffects();

    const posts = world.jira.calls.filter(
      (call) => call.method === 'POST' && call.pathname === '/rest/api/3/issue',
    );
    assert.deepEqual(
      posts.map((call) => call.status),
      [500, 500, 201],
    );
    assert.equal(world.jira.mutationsOf('createIssue').length, 1);
    const effect = await world.store.getEffect(requestKey);
    assert.equal(effect.status, 'applied');
    assert.equal(effect.tries, 3);
    assert.equal(effect.result.issueKey, world.jira.mutationsOf('createIssue')[0].issueKey);

    // The delayed retry messages must not create a second issue either.
    await effectApplierHandler({ body: { requestKey } });
    assert.equal(world.jira.mutationsOf('createIssue').length, 1);
    assert.equal((await world.store.getEffect(requestKey)).tries, 3);
  } finally {
    await world.close();
  }
});

testSerial('the watchdog re-pushes a stale pending effect and Jira still runs once', async () => {
  const world = await createWorld();
  try {
    const { run, steps } = await savePlan(world, {
      goal: 'Ship payment refunds',
      steps: [
        { title: 'Note the epic', workerType: 'research', input: 'refunds' },
      ],
    });
    const { requestKey } = await world.dependencies.enqueueEffect({
      runId: run.runId,
      stepId: steps[0].stepId,
      kind: 'comment',
      payload: { issueKey: DEMO_KEYS.refundsEpic, bodyText: 'pending too long' },
      discriminator: 'stale-comment',
    });
    assert.equal(world.bus.size('effect-queue'), 1);

    world.clock.advance(STALE_EFFECT_MS + 1);
    const summary = await world.watchdog.run();
    assert.deepEqual(
      summary.repushedEffects.map((effect) => effect.requestKey),
      [requestKey],
    );
    assert.equal(world.bus.size('effect-queue'), 2);

    await world.drainEffects();
    const comments = world.jira.mutationsOf('comment');
    assert.equal(comments.length, 1);
    assert.equal(comments[0].issueKey, DEMO_KEYS.refundsEpic);
    assert.equal((await world.store.getEffect(requestKey)).status, 'applied');
    assert.equal((await world.store.getEffect(requestKey)).tries, 1);
  } finally {
    await world.close();
  }
});

testSerial('a demo-hung step is recovered by the watchdog without a second child issue', async () => {
  const world = await createWorld();
  try {
    // Any non-empty value hangs step idx 0 on attempt 0. The worker must
    // observe this itself; the watchdog only retries what is left running.
    process.env.CONDUCTOR_DEMO_STUCK_STEP = 'true';
    const planned = seed.demo.planSteps.slice(0, 3).map((step) => ({
      title: step.title,
      workerType: step.workerType,
      input: step.input,
    }));
    const { run } = await savePlan(world, {
      goal: seed.demo.primaryGoal,
      steps: planned,
    });
    await startRun(run.runId, world.dependencies);

    await world.drainEffects();
    assert.equal(world.jira.mutationsOf('createIssue').length, planned.length);

    const hung = await world.processNextStep();
    assert.equal(hung.status, 'demo-hang');
    assert.equal(hung.reason, 'demo-stuck-step');
    assert.equal(hung.step.idx, 0);
    assert.equal(hung.step.attempt, 0);
    assert.equal(hung.step.status, 'running');

    // The original attempt is stale once the watchdog moves the step on.
    // Delivering it now, while the row is still attempt 0 and running, is the
    // duplicate-delivery case and must not do more work.
    // The next queued event is a sibling. Finish the steps that are not hung
    // before asking the watchdog to look. Summarize stays queued until the
    // hung step itself reaches done.
    const sibling = await world.processNextStep();
    assert.equal(sibling.status, 'done');
    await world.drainAll();

    const beforeRetry = await world.store.listSteps(run.runId);
    const stuck = beforeRetry.find((step) => step.idx === 0);
    assert.equal(stuck.status, 'running');
    assert.equal(stuck.attempt, 0);
    assert.ok(beforeRetry.filter((step) => step.idx !== 0).every((step) => step.status === 'done'));

    const tooSoon = await world.watchdog.run();
    assert.equal(tooSoon.retriedSteps.length, 0);

    world.clock.advance(STEP_DEADLINE_MS + 1);
    const recovered = await world.watchdog.run();
    assert.equal(recovered.retriedSteps.length, 1);
    assert.equal(recovered.retriedSteps[0].attempt, 1);
    assert.equal(recovered.failedSteps.length, 0);

    const stale = await stepWorkerHandler(
      { body: { runId: run.runId, stepId: stuck.stepId, attempt: 0 } },
      world.dependencies,
    );
    assert.equal(stale.status, 'stale');
    assert.equal(world.jira.mutationsOf('createIssue').length, planned.length);

    await world.drainAll();
    const finalSteps = await world.store.listSteps(run.runId);
    const retried = finalSteps.find((step) => step.idx === 0);
    assert.equal(retried.status, 'done');
    assert.equal(retried.attempt, 1);
    assert.ok(retried.childIssueKey);
    assert.equal(
      world.jira.mutationsOf('createIssue').filter((issue) => issue.summary === planned[0].title)
        .length,
      1,
    );
    const finished = await world.store.getRun(run.runId);
    assert.equal(finished.status, 'done');
    assertNoUnapprovedEffects(world, {
      epicKey: DEMO_KEYS.refundsEpic,
      plannedTitles: titlesOf(planned),
    });
  } finally {
    await world.close();
  }
});

testSerial('repeated stuck attempts end in one blocked run and one watchdog comment', async () => {
  const world = await createWorld();
  try {
    const { run, steps } = await savePlan(world, {
      goal: 'Ship payment refunds',
      steps: [
        {
          title: 'Hang until the budget is gone',
          workerType: 'research',
          input: 'refunds',
        },
      ],
    });
    await world.store.updateRun(run.runId, { status: 'running' });
    // A worker claimed this step and never finished. deadlineAt is already past.
    await world.store.updateStep(steps[0].stepId, {
      status: 'running',
      attempt: 0,
      deadlineAt: world.clock.now - 1,
    });

    /** @type {Array<number|string>} */
    const seen = [];
    for (let pass = 0; pass < 6; pass += 1) {
      const summary = await world.watchdog.run();
      assert.deepEqual(summary.errors, []);
      if (summary.failedSteps.length > 0) {
        seen.push('fail');
        assert.equal(summary.failedSteps.length, 1);
        assert.equal(summary.failedSteps[0].attempt, 3);
        break;
      }
      assert.equal(summary.retriedSteps.length, 1);
      seen.push(summary.retriedSteps[0].attempt);
      // The retry wrote a fresh 12-minute deadline. It is not stuck again
      // until that deadline passes, even though createdAt is older than 10 min.
      world.clock.advance(RETRY_DEADLINE_MS + 1);
    }
    // attempt 0, 1, and 2 are retried (the pushed attempts are 1, 2, 3).
    // The next pass sees attempt >= 3 and blocks the run.
    assert.deepEqual(seen, [1, 2, 3, 'fail']);

    const failedStep = await world.store.getStep(steps[0].stepId);
    assert.equal(failedStep.status, 'failed');
    assert.equal(failedStep.attempt, 3);
    assert.equal((await world.store.getRun(run.runId)).status, 'blocked');

    await world.drainEffects();
    const comments = world.jira.mutationsOf('comment');
    assert.equal(comments.length, 1);
    assert.equal(comments[0].issueKey, DEMO_KEYS.refundsEpic);
    assert.ok(comments[0].bodyText.startsWith(WATCHDOG_COMMENT_HEADER));

    const again = await world.watchdog.run();
    assert.equal(again.failedSteps.length, 0);
    assert.equal(again.retriedSteps.length, 0);
    await world.drainEffects();
    assert.equal(world.jira.mutationsOf('comment').length, 1);

    const [effect] = await world.store.listEffectsByStatus('applied');
    await effectApplierHandler({ body: { requestKey: effect.requestKey } });
    assert.equal(world.jira.mutationsOf('comment').length, 1);
    assert.equal(world.jira.mutationsOf('createIssue').length, 0);
  } finally {
    await world.close();
  }
});

testSerial('memory write-back from summarize is stored once and recalled once', async () => {
  const world = await createWorld();
  try {
    const decisionText = seed.expectedWriteBack.text;
    registerWorkerType('remember-decision', async () => ({
      output: {
        summary: 'Captured the refund rule.',
        decisions: [{ text: decisionText, type: 'decision' }],
      },
      effects: [],
    }));

    const { run } = await savePlan(world, {
      goal: seed.demo.primaryGoal,
      steps: [
        {
          title: 'List decisions to remember',
          workerType: 'remember-decision',
          input: 'payment id, ledger, webhook',
        },
      ],
    });
    await dispatchAndDrain(world, run.runId);

    const finished = await world.store.getRun(run.runId);
    assert.equal(finished.status, 'done');
    const memories = await world.store.listMemoriesByProject(DEMO_KEYS.projectKey);
    const decisions = memories.filter((memory) => memory.text === decisionText);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].memType, 'decision');
    assert.equal(decisions[0].scope, 'project');
    assert.equal(decisions[0].validUntil, 0);
    assert.equal(decisions[0].supersededBy, undefined);
    assert.equal(decisions[0].sourceIssue, DEMO_KEYS.refundsEpic);
    assert.equal(decisions[0].runId, run.runId);

    const epicComments = world.jira
      .mutationsOf('comment')
      .filter((comment) => comment.issueKey === DEMO_KEYS.refundsEpic);
    const memoryComments = epicComments.filter((comment) =>
      comment.bodyText.startsWith(MEMORY_COMMENT_HEADER),
    );
    assert.equal(memoryComments.length, 1);
    assert.ok(memoryComments[0].bodyText.includes(decisionText));
    assert.ok(epicComments.some((comment) => comment.bodyText.startsWith('[Conductor wave]')));

    // At-least-once summarize: the step event arrives again, and writeBack
    // is called again. Same memory row, same Epic comment.
    const steps = await world.store.listSteps(run.runId);
    const summarize = steps.find((step) => step.workerType === 'summarize');
    const duplicate = await stepWorkerHandler(
      {
        body: {
          runId: run.runId,
          stepId: summarize.stepId,
          attempt: summarize.attempt,
        },
      },
      world.dependencies,
    );
    assert.equal(duplicate.status, 'duplicate');
    await writeBack(
      run.runId,
      {
        summary: finished.summary,
        decisions: [{ text: decisionText, type: 'decision' }],
      },
      world.memoryDeps,
    );
    await world.drainEffects();
    const afterReplay = await world.store.listMemoriesByProject(DEMO_KEYS.projectKey);
    assert.equal(afterReplay.filter((memory) => memory.text === decisionText).length, 1);
    assert.equal(
      world.jira.mutationsOf('comment').filter((comment) =>
        comment.issueKey === DEMO_KEYS.refundsEpic
        && comment.bodyText.startsWith(MEMORY_COMMENT_HEADER),
      ).length,
      1,
    );

    const recalled = await recall(
      { projectKey: DEMO_KEYS.projectKey, query: seed.demo.relatedGoal },
      world.memoryDeps,
    );
    assert.ok(recalled.some((memory) => memory.text === decisionText));
    assert.equal(recalled[0].memType, 'decision');

    const commentsBeforeRecord = world.jira.mutationsOf('comment').length;
    const lesson =
      'reconcile against the provider statement before posting a ledger correction';
    const recorded = await record(
      {
        projectKey: DEMO_KEYS.projectKey,
        epicKey: DEMO_KEYS.reconcileEpic,
        text: lesson,
        type: 'lesson',
      },
      world.memoryDeps,
    );
    assert.equal(typeof recorded.memId, 'string');
    assert.equal(world.jira.mutationsOf('comment').length, commentsBeforeRecord);
    const lessonRow = await world.store.listMemoriesByProject(DEMO_KEYS.projectKey);
    assert.equal(
      lessonRow.find((memory) => memory.memId === recorded.memId).memType,
      'lesson',
    );

    const superseded = await world.store.addMemory({
      projectKey: DEMO_KEYS.projectKey,
      memType: 'decision',
      text: 'Superseded refund rule for the payment id ledger webhook.',
      sourceIssue: DEMO_KEYS.refundsEpic,
      validUntil: 0,
    });
    const replacement = await world.store.addMemory({
      projectKey: DEMO_KEYS.projectKey,
      memType: 'fact',
      text: 'Parking is unrelated.',
      sourceIssue: DEMO_KEYS.refundsEpic,
      validUntil: 0,
    });
    await world.store.supersedeMemory(superseded.memId, replacement.memId);
    await world.store.addMemory({
      projectKey: DEMO_KEYS.projectKey,
      memType: 'decision',
      text: 'Expired refund ledger rule for the payment id.',
      sourceIssue: DEMO_KEYS.refundsEpic,
      validUntil: world.clock.now - 1,
    });
    await world.store.addMemory({
      projectKey: 'OTHER',
      memType: 'decision',
      text: decisionText,
      sourceIssue: 'OTHER-1',
      validUntil: 0,
    });

    const filtered = await recall(
      { projectKey: DEMO_KEYS.projectKey, query: seed.demo.relatedGoal },
      world.memoryDeps,
    );
    const filteredText = filtered.map((memory) => memory.text);
    assert.ok(filteredText.includes(decisionText));
    assert.ok(!filteredText.includes(superseded.text));
    assert.ok(!filteredText.includes('Expired refund ledger rule for the payment id.'));
    assert.ok(filtered.every((memory) => memory.projectKey === DEMO_KEYS.projectKey));
  } finally {
    await world.close();
  }
});

testSerial('prompt-injection text in ticket bodies does not cause unapproved effects', async () => {
  const world = await createWorld({ poison: true });
  try {
    const planned = seed.demo.planSteps.map((step) => ({
      title: step.title,
      workerType: step.workerType,
      input: `${step.input}\n${PROMPT_INJECTION}`,
    }));
    const goal = `${seed.demo.primaryGoal}\n${PROMPT_INJECTION}`;
    const { run, steps } = await savePlan(world, { goal, steps: planned });

    // The smuggled JSON array inside the goal is not a plan. Step count stays
    // at the real plan, and every input is still a string.
    assert.equal(steps.length, planned.length);
    assert.ok(steps.every((step) => typeof step.input === 'string'));
    assert.equal(world.jira.calls.length, 0);

    await dispatchAndDrain(world, run.runId);
    assert.equal((await world.store.getRun(run.runId)).status, 'done');
    assertNoUnapprovedEffects(world, {
      epicKey: DEMO_KEYS.refundsEpic,
      plannedTitles: titlesOf(planned),
      descriptionIncludes: 'https://example.com/plan',
    });
    assert.ok(
      world.jira.mutationsOf('createIssue').every(
        (issue) => issue.summary !== 'Smuggled extra issue',
      ),
    );
    // The token rode along inside a Jira field or a worker comment. It did
    // not become a transition.
    const echoed = [
      ...world.jira.mutationsOf('createIssue').map((issue) => issue.descriptionText),
      ...world.jira.mutationsOf('comment').map((comment) => comment.bodyText),
    ].join('\n');
    assert.ok(echoed.includes(INJECTION_TOKEN) || echoed.includes('https://example.com/plan'));
    assert.equal(world.jira.mutationsOf('transition').length, 0);
    assert.equal(world.fetches.length, 0);
    // The URL was copied into the research JQL. It was not fetched.
    assert.ok(
      world.jira.calls.some(
        (call) =>
          call.pathname === '/rest/api/3/search/jql' &&
          call.path.includes('example.com'),
      ),
    );
  } finally {
    await world.close();
  }
});
