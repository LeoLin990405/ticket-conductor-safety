/**
 * Unit tests for the four built-in deterministic worker types.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkDepsWorker,
  defaultResearchJql,
  draftSpecWorker,
  researchWorker,
  summarizeWorker,
} from '../workerTypes.js';
import {
  getWorkerType,
  listWorkerTypes,
  registerWorkerType,
  resetWorkerTypes,
  unregisterWorkerType,
} from '../index.js';

const run = {
  runId: 'run-1',
  epicKey: 'TC-1',
  projectKey: 'TC',
  goal: 'Ship payment refunds',
  status: 'running',
};

/**
 * @param {Partial<import('../../store/types.js').Step>} [overrides]
 * @returns {import('../../store/types.js').Step}
 */
function step(overrides = {}) {
  return {
    stepId: 'step-1',
    runId: 'run-1',
    idx: 0,
    title: 'Research refunds',
    workerType: 'research',
    status: 'running',
    attempt: 0,
    createdAt: 1_700_000_000_000,
    childIssueKey: 'TC-2',
    input: {},
    ...overrides,
  };
}

function ctx(overrides = {}) {
  return {
    run,
    store: {
      async listSteps() {
        return [];
      },
    },
    jira: {
      async searchIssues() {
        return [];
      },
      async getIssueLinks() {
        return [];
      },
    },
    now: () => 1_700_000_123_000,
    logger: console,
    attempt: 0,
    ...overrides,
  };
}

test.afterEach(() => resetWorkerTypes());

test('research uses an explicit JQL query and comments on the child issue', async () => {
  const queries = [];
  const context = ctx({
    jira: {
      async searchIssues(jql, options) {
        queries.push({ jql, options });
        return [
          { key: 'TC-9', summary: 'Refund flow', status: 'In Progress', issueType: 'Story' },
        ];
      },
    },
  });

  const result = await researchWorker(
    step({ input: { jql: 'project = TC', limit: 5 } }),
    context,
  );
  assert.deepEqual(queries, [
    { jql: 'project = TC', options: { limit: 5 } },
  ]);
  assert.equal(result.output.count, 1);
  assert.equal(result.output.issues[0].key, 'TC-9');
  assert.equal(result.effects[0].kind, 'comment');
  assert.equal(result.effects[0].payload.issueKey, 'TC-2');
  assert.equal(result.effects[0].discriminator, 'research-comment');
});

test('research builds a safe default JQL query from the goal', async () => {
  const jql = defaultResearchJql(run, step());
  assert.match(jql, /^project = "TC"/);
  assert.match(jql, /text ~ "Research refunds Ship payment/);
  assert.match(jql, /AND key != "TC-1"/);
});

test('draft-spec renders the plan input as a markdown specification', async () => {
  const result = await draftSpecWorker(
    step({
      title: 'Draft refund spec',
      input: {
        description: 'Add a refund endpoint.',
        acceptanceCriteria: ['Refund succeeds', 'Audit event written'],
        context: 'Payments service',
      },
    }),
    ctx(),
  );

  assert.equal(result.output.summary, 'Draft refund spec');
  assert.match(result.output.description, /# Draft refund spec/);
  assert.match(result.output.description, /Add a refund endpoint\./);
  assert.match(result.output.description, /- Refund succeeds/);
  assert.deepEqual(result.output.acceptanceCriteria, [
    'Refund succeeds',
    'Audit event written',
  ]);
  assert.equal(result.effects[0].payload.bodyText, result.output.description);
});

test('check-deps reports linked issues that are not done', async () => {
  const result = await checkDepsWorker(
    step({ workerType: 'check-deps' }),
    ctx({
      jira: {
        async getIssueLinks(issueKey) {
          assert.equal(issueKey, 'TC-2');
          return [
            {
              key: 'TC-7',
              summary: 'Payments migration',
              status: 'In Progress',
              type: 'blocks',
              direction: 'inward',
            },
            {
              key: 'TC-8',
              summary: 'API gateway',
              status: 'Done',
              type: 'depends on',
              direction: 'outward',
            },
          ];
        },
      },
    }),
  );

  assert.equal(result.output.count, 2);
  assert.equal(result.output.blockers.length, 1);
  assert.equal(result.output.blockers[0].key, 'TC-7');
  assert.match(result.effects[0].payload.bodyText, /1 not done/);
});

test('summarize aggregates completed outputs, keeps decisions, and comments on the Epic', async () => {
  const completed = [
    step({
      stepId: 'step-a',
      idx: 0,
      title: 'Research refunds',
      status: 'done',
      output: {
        summary: 'Found two related issues.',
        decisions: [{ text: 'Use the existing refund table.', type: 'decision' }],
      },
    }),
    step({
      stepId: 'step-b',
      idx: 1,
      title: 'Draft spec',
      status: 'done',
      output: {
        description: 'Refund API draft.',
        decisions: [
          { text: 'Use the existing refund table.', type: 'decision' },
          { text: 'Callbacks must be idempotent.', type: 'lesson' },
        ],
      },
    }),
    step({
      stepId: 'current',
      idx: 2,
      title: 'Summarize',
      workerType: 'summarize',
      status: 'running',
    }),
  ];

  const result = await summarizeWorker(
    completed[2],
    ctx({
      store: {
        async listSteps() {
          return completed;
        },
      },
    }),
  );

  assert.match(result.output.summary, /completed 2 step\(s\)/);
  assert.match(result.output.summary, /Found two related issues\./);
  assert.equal(result.output.decisions.length, 2);
  assert.deepEqual(result.output.decisions[1], {
    text: 'Callbacks must be idempotent.',
    type: 'lesson',
  });
  assert.equal(result.output.completedAt, 1_700_000_123_000);
  assert.equal(result.output.generator, 'fallback');

  // This step already has a child issue, so the summary is posted there.
  // The Epic "[Conductor memory]" comment is still WP6's, from output.summary.
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0].kind, 'comment');
  assert.equal(result.effects[0].payload.issueKey, 'TC-2');
  assert.equal(result.effects[0].discriminator, 'summarize-comment');
  assert.equal(result.effects[0].payload.bodyAdf.type, 'doc');
  assert.match(result.effects[0].payload.bodyText, /completed 2 step/);
});

test('summarize does not defer a comment when the automatic step has no child issue', async () => {
  const result = await summarizeWorker(
    step({
      stepId: 'current',
      title: 'Summarize',
      workerType: 'summarize',
      childIssueKey: undefined,
    }),
    ctx({
      store: {
        async listSteps() {
          return [];
        },
      },
    }),
  );
  assert.deepEqual(result.effects, []);
  assert.match(result.output.summary, /no completed steps/);
});

test('the registry exposes the built-in workers and supports temporary types', () => {
  assert.deepEqual(listWorkerTypes(), [
    'approval',
    'check-deps',
    'draft-spec',
    'research',
    'summarize',
  ]);

  const handler = async () => ({ output: {} });
  assert.equal(registerWorkerType('temporary-type', handler), undefined);
  assert.equal(getWorkerType('temporary-type'), handler);
  assert.equal(unregisterWorkerType('temporary-type'), true);
  assert.equal(getWorkerType('temporary-type'), undefined);

  assert.throws(() => registerWorkerType('Bad Name', handler), /lowercase/);
  assert.throws(() => registerWorkerType('valid', null), /function/);
});

test('research turns plain-language string input into a safe text search (live JQL 400 regression)', async () => {
  const calls = [];
  const result = await researchWorker(
    { stepId: 's', runId: 'r', idx: 0, title: 'Research', workerType: 'research', input: 'Search TD for onboarding docs', attempt: 0, status: 'running' },
    { run: { projectKey: 'TD', epicKey: 'TD-1', goal: 'onboarding' }, jira: { async searchIssues(jql) { calls.push(jql); return []; } } },
  );
  assert.ok(result);
  assert.match(calls[0], /^project = "TD" AND text ~ "/);
  assert.doesNotMatch(calls[0], /^Search TD/);
});

test('research still passes real JQL strings through', async () => {
  const calls = [];
  await researchWorker(
    { stepId: 's', runId: 'r', idx: 0, title: 'R', workerType: 'research', input: 'project = TD ORDER BY created', attempt: 0, status: 'running' },
    { run: { projectKey: 'TD', epicKey: 'TD-1', goal: 'g' }, jira: { async searchIssues(jql) { calls.push(jql); return []; } } },
  );
  assert.equal(calls[0], 'project = TD ORDER BY created');
});

test('researchWorker defers its comment when the child issue key is not set yet', async () => {
  const { researchWorker } = await import('../workerTypes.js');
  const result = await researchWorker(
    { stepId: 's-1', title: 'Research', input: 'recent changes' },
    { run: { projectKey: 'TD', epicKey: 'TD-1' }, jira: { searchIssues: async () => [] } },
  );
  assert.equal(result.output.count, 0);
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0].payload.childOfStepId, 's-1');
  assert.equal(result.effects[0].payload.issueKey, undefined);
  assert.equal(result.effects[0].payload.bodyAdf.type, 'doc');
  assert.match(result.effects[0].payload.bodyText, /No related issues/);
});
