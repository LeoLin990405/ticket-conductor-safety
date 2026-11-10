/**
 * WP12: lessons change the next plan.
 *
 * Run 1 fails on a known cause. The lesson is proposed, not applied. After a
 * person accepts it, run 2 prepends a check-deps step and cites the lesson id.
 * A rejected lesson is not applied. Edits and downvotes keep the old row and
 * only change the validity window, so a replay can read the earlier version.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { planSplit, recallMemory } from '../../actions/index.js';
import {
  resetEffectDependencies,
  setEffectQueue,
} from '../../effects/index.js';
import { reportStep } from '../../run/stateMachine.js';
import {
  createMemoryStore,
  resetStore,
  setStore,
} from '../../store/index.js';
import { resetWorkerTypes } from '../../worker/index.js';
import { createWatchdog } from '../../watchdog/watchdog.js';
import {
  createClock,
  createRunWithSteps,
  createWatchdogDeps,
  markRunningOverdue,
} from '../../watchdog/__tests__/helpers.js';
import { utf8Size } from '../lessonText.js';
import {
  GLOBAL_PROJECT_KEY,
  acceptLesson,
  addLesson,
  downvoteLesson,
  editLesson,
  lessonsAt,
  listLessons,
  recall,
  rejectLesson,
  resetMemory,
  writeBack,
} from '../index.js';

const GOAL = 'Ship payment refunds';
const STEPS = [
  { title: 'Research billing access', workerType: 'research', input: 'refunds' },
  { title: 'Draft the refund spec', workerType: 'draft-spec', input: 'ledger' },
];

function deps(store, now) {
  return { store, now };
}

test('lesson writes fail closed without a scope and dedupe identical text', async () => {
  const store = createMemoryStore();
  await assert.rejects(
    () => addLesson({ projectKey: 'PAY', text: 'Remember the ledger.' }, { store }),
    /scope is required/,
  );

  const first = await addLesson({
    projectKey: 'PAY',
    scope: 'project',
    epicKey: 'PAY-1',
    text: 'Refund ledger rows are immutable.',
    cause: 'immutable ledger rows',
  }, { store });
  const second = await addLesson({
    projectKey: 'PAY',
    scope: 'project',
    epicKey: 'PAY-1',
    text: 'Refund ledger rows are immutable.',
    cause: 'immutable ledger rows',
  }, { store });

  assert.equal(first.op, 'add');
  assert.equal(second.op, 'noop');
  assert.equal(second.lessonId, first.lessonId);
  assert.equal((await store.listMemoriesByProject('PAY')).length, 1);
  assert.equal(first.scope, 'project');
  assert.equal(first.tier, 'project');
  assert.equal(typeof first.confidence, 'number');
  assert.equal(first.votes, 0);
  assert.equal(first.status, 'proposed');
});

test('edit and downvote keep history and replay reads the version that held then', async () => {
  let now = 5_000;
  const store = createMemoryStore({ now: () => now });
  const clock = () => now;
  const first = await addLesson({
    projectKey: 'PAY',
    scope: 'project',
    epicKey: 'PAY-1',
    text: 'Refund ledger uses a lock.',
    cause: 'ledger lock',
    goal: GOAL,
  }, deps(store, clock));
  const accepted = await acceptLesson({
    lessonId: first.lessonId,
    projectKey: 'PAY',
  }, deps(store, clock));
  assert.equal(accepted.status, 'accepted');
  assert.ok(accepted.votes >= 1);
  assert.notEqual(accepted.lessonId, first.lessonId);

  now = 8_000;
  const edited = await editLesson({
    lessonId: accepted.lessonId,
    projectKey: 'PAY',
    text: 'Refund ledger uses an idempotency key.',
  }, deps(store, clock));
  assert.equal(edited.op, 'edit');
  assert.equal(edited.votes, accepted.votes);

  const atAccept = await lessonsAt({
    projectKey: 'PAY',
    asOf: accepted.validFrom,
    query: 'refund ledger',
  }, deps(store, clock));
  assert.ok(atAccept.some((lesson) => lesson.lessonId === accepted.lessonId));
  assert.ok(!atAccept.some((lesson) => lesson.lessonId === edited.lessonId));

  const atEdit = await lessonsAt({
    projectKey: 'PAY',
    asOf: edited.validFrom,
    query: 'refund ledger',
  }, deps(store, clock));
  assert.ok(atEdit.some((lesson) => lesson.lessonId === edited.lessonId));
  assert.ok(!atEdit.some((lesson) => lesson.lessonId === accepted.lessonId));

  now = 9_000;
  const dropped = await downvoteLesson({
    lessonId: edited.lessonId,
    projectKey: 'PAY',
  }, deps(store, clock));
  assert.equal(dropped.expired, true);
  assert.equal(dropped.votes < 1, true);
  const stillThere = await listLessons({ projectKey: 'PAY' }, deps(store, clock));
  assert.ok(stillThere.some((lesson) => lesson.lessonId === dropped.lessonId));
  assert.equal(
    (await store.listMemoriesByProject('PAY')).some((memory) => memory.memId === first.lessonId),
    true,
    'the original lesson row is expired by a successor, not deleted',
  );

  const replay = await recall({
    projectKey: 'PAY',
    query: 'refund ledger lock',
    asOf: first.validFrom,
    k: 5,
  }, deps(store, clock));
  assert.ok(replay.some((memory) => memory.memId === first.lessonId));
});

test('a global lesson is recalled for a project and ranks under a project lesson', async () => {
  const store = createMemoryStore();
  const global = await addLesson({
    scope: 'global',
    text: 'Last run blocked on missing access to billing-api while working on "Ship payment refunds".',
    cause: 'missing access to billing-api',
    goal: GOAL,
  }, { store });
  await acceptLesson({
    lessonId: global.lessonId,
    projectKey: GLOBAL_PROJECT_KEY,
  }, { store });

  const project = await addLesson({
    projectKey: 'PAY',
    scope: 'project',
    epicKey: 'PAY-1',
    text: 'Last run blocked on missing access to the project billing role while working on "Ship payment refunds".',
    cause: 'missing access to the project billing role',
    goal: GOAL,
  }, { store });
  const acceptedProject = await acceptLesson({
    lessonId: project.lessonId,
    projectKey: 'PAY',
  }, { store });

  const { applyMemoriesToPlan } = await import('../lessons.js');
  const plan = await applyMemoriesToPlan({
    projectKey: 'PAY',
    epicKey: 'PAY-1',
    goal: 'Ship the payment refunds API',
    steps: STEPS,
    maxSteps: 8,
  }, { store });

  assert.equal(plan.steps[0].workerType, 'check-deps');
  assert.equal(plan.usedLessons[0], acceptedProject.lessonId);
  assert.ok(plan.usedLessons.includes(acceptedProject.lessonId));
  assert.match(plan.planCard, /Used lessons:/);
  assert.match(plan.planCard, new RegExp(acceptedProject.lessonId));
});

test('recall stays inside the byte budget', async () => {
  const store = createMemoryStore();
  await store.addMemory({
    projectKey: 'PAY',
    memType: 'fact',
    text: `${'refund ledger '.repeat(80)}provider statement`,
    sourceIssue: 'PAY-1',
  });
  await store.addMemory({
    projectKey: 'PAY',
    memType: 'fact',
    text: 'provider statement is short',
    sourceIssue: 'PAY-2',
  });

  const recalled = await recall({
    projectKey: 'PAY',
    query: 'refund ledger provider statement',
    budgetBytes: 40,
  }, { store });

  assert.ok(recalled.length >= 1);
  let bytes = 0;
  for (const memory of recalled) {
    bytes += utf8Size(memory.text);
  }
  assert.ok(bytes <= 40, `recalled ${bytes} bytes`);
  assert.equal(typeof recalled[0].confidence, 'number');
  assert.equal(recalled[0].tier, 'project');
});

test('demo: run 1 fails on missing access, an accepted lesson makes run 2 cite it', async () => {
  const store = createMemoryStore({ now: () => Date.now() });
  setStore(store);
  setEffectQueue({
    async push() {
      return { ok: true };
    },
  });
  try {
    const run = await store.createRun({
      epicKey: 'PAY-1',
      projectKey: 'PAY',
      goal: GOAL,
      createdBy: 'acct-1',
    });
    const steps = await store.createSteps(run.runId, STEPS);
    await reportStep(steps[0].stepId, {
      status: 'failed',
      error: { message: 'Jira 403 missing access to billing-api' },
    });

    const proposed = await listLessons({ projectKey: 'PAY' });
    assert.equal(proposed.length, 1);
    assert.equal(proposed[0].rawStatus, 'proposed');
    assert.equal(proposed[0].votes, 0);
    assert.match(proposed[0].summary, /missing access to billing-api/);
    assert.match(proposed[0].summary, /Ship payment refunds/);

    const before = await planSplit({
      epicKey: 'PAY-1',
      goal: 'Ship the payment refunds API',
      steps: STEPS,
    });
    assert.equal(before.steps[0].workerType, 'research');
    assert.deepEqual(before.usedLessons, []);

    const accepted = await acceptLesson({
      lessonId: proposed[0].lessonId,
      projectKey: 'PAY',
    });
    assert.equal(accepted.status, 'accepted');
    assert.ok(accepted.votes >= 1);

    const after = await planSplit({
      epicKey: 'PAY-1',
      goal: 'Ship the payment refunds API',
      steps: STEPS,
    });
    assert.equal(after.steps[0].workerType, 'check-deps');
    assert.deepEqual(after.steps.map((step) => step.dependsOn), [[], [0], [0]]);
    assert.equal(after.steps[1].title, 'Research billing access');
    assert.notDeepEqual(
      after.steps.map((step) => step.title),
      before.steps.map((step) => step.title),
    );
    assert.deepEqual(after.usedLessons, [accepted.lessonId]);
    assert.match(after.planCard, new RegExp(`Lesson ${accepted.lessonId}`));
    assert.match(
      after.planCard,
      /last run failed on missing access to billing-api, so added a check-deps step first/,
    );
    assert.equal(after.steps[0].input.lessonId, accepted.lessonId);
    assert.match(after.steps[0].input.citation, new RegExp(accepted.lessonId));

    const effects = await store.listEffectsByStatus('pending');
    const card = effects.find((effect) => (
      typeof effect.payload?.bodyText === 'string' &&
      effect.payload.bodyText.startsWith('[Conductor plan]')
    ));
    assert.ok(card, 'the plan card is an Epic comment');
    assert.match(card.payload.bodyText, new RegExp(accepted.lessonId));
    assert.equal(card.payload.issueKey, 'PAY-1');

    await rejectLesson({
      lessonId: accepted.lessonId,
      projectKey: 'PAY',
    });
    const rejected = await planSplit({
      epicKey: 'PAY-1',
      goal: 'Ship the payment refunds API',
      steps: STEPS,
    });
    assert.equal(rejected.steps[0].workerType, 'research');
    assert.deepEqual(rejected.usedLessons, []);
  } finally {
    resetEffectDependencies();
    resetMemory();
    resetStore();
    resetWorkerTypes();
  }
});

test('summarize lessons are proposed once and recall-memory waits for accept', async () => {
  const store = createMemoryStore();
  setStore(store);
  try {
    const run = await store.createRun({
      epicKey: 'PAY-1',
      projectKey: 'PAY',
      goal: GOAL,
      createdBy: 'acct-1',
    });
    const input = {
      summary: 'Run finished.',
      decisions: [{
        text: 'Callbacks must be idempotent on the payment id.',
        type: 'lesson',
      }],
    };
    const writeDeps = {
      store,
      enqueueEffect: async () => ({ requestKey: 'k', created: true }),
    };
    const first = await writeBack(run.runId, input, writeDeps);
    const second = await writeBack(run.runId, input, writeDeps);
    assert.deepEqual(second.memIds, first.memIds);
    assert.equal((await store.listMemoriesByProject('PAY')).length, 1);

    const lessons = await listLessons({ projectKey: 'PAY' }, { store });
    assert.equal(lessons.length, 1);
    assert.equal(lessons[0].rawStatus, 'proposed');
    assert.equal(lessons[0].kind, 'summarize');
    assert.doesNotMatch(JSON.stringify(lessons[0].patch), /blocked/);
    assert.equal(lessons[0].outcome, 'succeeded');

    const hidden = await recallMemory({
      projectKey: 'PAY',
      query: 'idempotent payment callbacks',
    });
    assert.equal(hidden.ok, true);
    assert.deepEqual(hidden.memories, []);

    await acceptLesson({
      lessonId: lessons[0].lessonId,
      projectKey: 'PAY',
    }, { store });
    const shown = await recallMemory({
      projectKey: 'PAY',
      query: 'idempotent payment callbacks',
    });
    assert.equal(shown.memories.length, 1);
    assert.equal(shown.memories[0].memType, 'lesson');
    assert.equal(shown.memories[0].scope, 'project');
    assert.match(shown.memories[0].text, /Callbacks must be idempotent/);
    assert.doesNotMatch(shown.memories[0].text, /\[Conductor lesson\]/);
    assert.ok(utf8Size(shown.memories[0].text) <= 1536);
  } finally {
    resetMemory();
    resetStore();
  }
});

test('an inserted check-deps step is what the later steps wait on', async () => {
  const store = createMemoryStore();
  const added = await addLesson({
    projectKey: 'PAY',
    scope: 'project',
    epicKey: 'PAY-1',
    text: 'Last run blocked on missing access to billing-api while working on "Ship payment refunds".',
    cause: 'missing access to billing-api',
    goal: GOAL,
  }, { store });
  const accepted = await acceptLesson({
    lessonId: added.lessonId,
    projectKey: 'PAY',
  }, { store });
  const { applyMemoriesToPlan } = await import('../lessons.js');
  const chain = await applyMemoriesToPlan({
    projectKey: 'PAY',
    epicKey: 'PAY-1',
    goal: 'Ship the payment refunds API',
    maxSteps: 8,
    steps: [
      { title: 'Research billing access', workerType: 'research', input: 'refunds', dependsOn: [] },
      { title: 'Draft the refund spec', workerType: 'draft-spec', input: 'ledger', dependsOn: [0] },
    ],
  }, { store });
  assert.equal(chain.steps[0].workerType, 'check-deps');
  assert.deepEqual(chain.steps.map((step) => step.dependsOn), [[], [0], [0, 1]]);
  assert.equal(chain.usedLessons[0], accepted.lessonId);

  const moved = await applyMemoriesToPlan({
    projectKey: 'PAY',
    epicKey: 'PAY-1',
    goal: 'Ship the payment refunds API',
    maxSteps: 8,
    steps: [
      { title: 'Research billing access', workerType: 'research', input: 'refunds', dependsOn: [] },
      { title: 'Draft the refund spec', workerType: 'draft-spec', input: 'ledger', dependsOn: [0] },
      { title: 'Check links', workerType: 'check-deps', input: 'links', dependsOn: [1] },
    ],
  }, { store });
  assert.equal(moved.steps[0].workerType, 'check-deps');
  assert.deepEqual(moved.steps.map((step) => step.dependsOn), [[], [0], [0, 1]]);
  assert.match(JSON.stringify(moved.steps[0].input), /Lesson /);
});

test('a watchdog retry records a proposed lesson on the project', async () => {
  const clock = createClock();
  const store = createMemoryStore({ now: clock.now });
  const { steps } = await createRunWithSteps(store, {
    epicKey: 'PAY-1',
    projectKey: 'PAY',
    goal: GOAL,
  });
  await markRunningOverdue(store, steps[0], { now: clock.now(), attempt: 0 });
  const { deps: watchdogDeps } = createWatchdogDeps(store, { now: clock.now });
  await createWatchdog(watchdogDeps).run();

  const lessons = await listLessons({ projectKey: 'PAY' }, { store });
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].rawStatus, 'proposed');
  assert.match(lessons[0].cause, /stuck step/);
  assert.equal(lessons[0].scope, 'project');
});

test('an accepted lesson that needs a person appends one approval gate', async () => {
  const store = createMemoryStore();
  const added = await addLesson({
    projectKey: 'PAY',
    scope: 'project',
    epicKey: 'PAY-1',
    text: 'The draft-spec step needs a person before it writes the refund spec.',
    cause: 'draft-spec needs a person',
    goal: GOAL,
    workerType: 'draft-spec',
  }, { store });
  const accepted = await acceptLesson({
    lessonId: added.lessonId,
    projectKey: 'PAY',
  }, { store });
  const { applyMemoriesToPlan } = await import('../lessons.js');
  const plan = await applyMemoriesToPlan({
    projectKey: 'PAY',
    epicKey: 'PAY-1',
    goal: 'Ship the payment refunds API',
    maxSteps: 8,
    steps: [
      { title: 'Research refunds', workerType: 'research', input: 'refunds', dependsOn: [] },
      { title: 'Draft the refund spec', workerType: 'draft-spec', input: 'ledger', dependsOn: [0] },
    ],
  }, { store });
  assert.equal(plan.steps[0].workerType, 'research');
  assert.deepEqual(plan.steps[0].dependsOn, []);
  assert.equal(plan.steps[1].workerType, 'draft-spec');
  assert.deepEqual(plan.steps[1].dependsOn, [0, 2]);
  assert.equal(plan.steps[2].workerType, 'approval');
  assert.deepEqual(plan.steps[2].dependsOn, []);
  assert.equal(plan.steps[2].input.lessonId, accepted.lessonId);
  assert.match(plan.planCard, new RegExp(accepted.lessonId));
  assert.match(plan.planCard, /a person must approve/);
  assert.equal(plan.steps.some((step) => step.workerType === 'check-deps'), false);

  const full = await applyMemoriesToPlan({
    projectKey: 'PAY',
    epicKey: 'PAY-1',
    goal: 'Ship the payment refunds API',
    maxSteps: 8,
    steps: Array.from({ length: 8 }, (_, index) => ({
      title: `Step ${index}`,
      workerType: index === 3 ? 'draft-spec' : 'research',
      input: 'refunds',
      dependsOn: [],
    })),
  }, { store });
  assert.equal(full.steps.length, 8);
  assert.equal(full.steps.some((step) => step.workerType === 'approval'), false);
  assert.match(String(full.steps[3].input), new RegExp(accepted.lessonId));
});
