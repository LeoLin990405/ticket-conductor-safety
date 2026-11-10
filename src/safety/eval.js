/**
 * One-command check of the irreversible-action guarantees.
 *
 * `npm run safety-eval` prints the table. The unit test imports
 * {@link runSafetyEval} and fails if any row is not a pass. Everything
 * here uses the in-memory store and stub queues. No Jira, no Rovo, and
 * no model call leaves the process.
 *
 * @module safety/eval
 */

import { readFileSync } from 'node:fs';

import { dispatchRun, forkRun, planSplit } from '../actions/index.js';
import { handoffGoal } from '../actions/handoff.js';
import { RUN_MAX_MODEL_CALLS, RUN_WALL_CLOCK_MS } from '../run/budget.js';
import { createMemoryStore, resetStore, setStore } from '../store/index.js';
import { resetWorkerTypes } from '../worker/index.js';
import { completeText } from '../worker/llm.js';

const root = new URL('../../', import.meta.url);

/**
 * @typedef {object} SafetyRow
 * @property {string} property
 * @property {'PASS'|'FAIL'} result
 * @property {string} detail
 */

/**
 * @returns {Promise<SafetyRow[]>}
 */
export async function runSafetyEval() {
  /** @type {SafetyRow[]} */
  const rows = [];
  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  setStore(store);
  /** @type {object[]} */
  const enqueued = [];
  const overrides = {
    store,
    now: () => 1_700_000_000_000,
    enqueueEffect: async (effect) => {
      enqueued.push(effect);
      return { requestKey: `k-${enqueued.length}`, created: true };
    },
    enqueueStep: async () => ({ jobId: 'job' }),
  };
  try {
    const planned = await planSplit({
      epicKey: 'PAY-1',
      projectKey: 'PAY',
      goal: 'Ship refunds',
      steps: [
        { title: 'Research refunds', workerType: 'research', input: 'refunds' },
        { title: 'Approve the spec', workerType: 'approval', input: 'a person signs off', dependsOn: [] },
        { title: 'Draft the spec', workerType: 'draft-spec', input: 'payment id', dependsOn: [1] },
      ],
    });

    rows.push(await check('dispatch with no confirm enqueues nothing', async () => {
      const before = enqueued.length;
      const refused = await dispatchRun({ runId: planned.runId }, {}, overrides);
      assert(refused.ok === false && refused.code === 'CONFIRMATION_REQUIRED', refused.code);
      assert((await store.getRun(planned.runId)).status === 'planning', 'status');
      assert(enqueued.length === before, 'enqueued');
    }));

    rows.push(await check('boolean confirm without the token enqueues nothing', async () => {
      const before = enqueued.length;
      const refused = await dispatchRun(
        { runId: planned.runId, confirm: true },
        {},
        overrides,
      );
      assert(refused.ok === false && refused.code === 'CONFIRMATION_REQUIRED', refused.error);
      assert(enqueued.length === before, 'enqueued');
    }));

    rows.push(await check('the string "true" is not confirmation', async () => {
      const refused = await dispatchRun({
        runId: planned.runId,
        confirm: 'true',
        acknowledgeBlastRadius: planned.acknowledgement,
        confirmToken: planned.confirmToken,
      }, {}, overrides);
      assert(refused.ok === false && refused.code === 'CONFIRMATION_REQUIRED', refused.error);
      assert((await store.getRun(planned.runId)).status === 'planning', 'status');
    }));

    rows.push(await check('a wrong acknowledgement is rejected', async () => {
      const refused = await dispatchRun({
        runId: planned.runId,
        confirm: true,
        acknowledgeBlastRadius: '0 points, 0 issues, 0 transitions, 0 field changes',
        confirmToken: planned.confirmToken,
      }, {}, overrides);
      assert(refused.ok === false, refused.code);
      assert(enqueued.length === 0, 'enqueued');
    }));

    rows.push(await check('a token from another card is rejected', async () => {
      const refused = await dispatchRun({
        runId: planned.runId,
        confirm: true,
        acknowledgeBlastRadius: planned.acknowledgement,
        confirmToken: '0'.repeat(64),
      }, {}, overrides);
      assert(refused.ok === false && refused.code === 'CONFIRMATION_REQUIRED', refused.error);
    }));

    rows.push(await check('a matching token is the only path that enqueues', async () => {
      const started = await dispatchRun({
        runId: planned.runId,
        confirm: true,
        acknowledgeBlastRadius: planned.acknowledgement,
        confirmToken: planned.confirmToken,
      }, {}, overrides);
      assert(started.ok === true && started.status === 'running', started.status);
      const creates = enqueued.filter((effect) => effect.kind === 'createIssue');
      const titles = creates.map((effect) => effect.payload.summary).sort();
      assert(titles.includes('Research refunds'), 'sibling');
      assert(titles.includes('Approve the spec'), 'gate');
      assert(!titles.includes('Draft the spec'), `draft was created early: ${titles.join(',')}`);
    }));

    rows.push(await check('handoff cannot dispatch by itself', async () => {
      const handed = await handoffGoal({
        epicKey: 'PAY-1',
        projectKey: 'PAY',
        goal: 'Ship refunds again',
        confirm: true,
        stepsJson: JSON.stringify([
          { title: 'Research refunds', workerType: 'research', input: 'refunds' },
        ]),
      }, {}, overrides);
      assert(handed.awaitingConfirmation === true, 'awaiting');
      assert(handed.status === 'planning', handed.status);
      assert(!handed.calls.some((call) => call.tool === 'dispatch-run'), 'dispatched');
    }));

    rows.push(await check('fork without a token writes nothing', async () => {
      const before = enqueued.length;
      const refused = await forkRun({
        runId: planned.runId,
        stepIdx: 0,
        confirm: true,
      }, {}, overrides);
      assert(refused.ok === false && refused.code === 'CONFIRMATION_REQUIRED', refused.error);
      assert(enqueued.length === before, 'enqueued');
    }));

    rows.push(await check('a blown wall clock blocks dispatch before any write', async () => {
      const late = await planSplit({
        epicKey: 'PAY-1',
        projectKey: 'PAY',
        goal: 'Late refunds',
        steps: [{ title: 'Research refunds', workerType: 'research', input: 'refunds' }],
      });
      const stored = await store.getRun(late.runId);
      await store.updateRun(late.runId, {
        budget: { ...stored.budget, elapsedMs: RUN_WALL_CLOCK_MS + 1 },
      });
      const before = enqueued.length;
      const stopped = await dispatchRun({
        runId: late.runId,
        confirm: true,
        acknowledgeBlastRadius: late.acknowledgement,
        confirmToken: late.confirmToken,
      }, {}, overrides);
      assert(stopped.ok === false && stopped.code === 'BUDGET_EXCEEDED', stopped.code);
      assert(stopped.status === 'blocked', stopped.status);
      assert(enqueued.length === before, 'enqueued');
    }));

    rows.push(await check('a full model-call budget does not call the model', async () => {
      let chats = 0;
      const result = await completeText(
        {
          system: 'rules',
          user: 'data',
          budget: {
            maxSteps: 8,
            maxModelCalls: RUN_MAX_MODEL_CALLS,
            wallClockMs: RUN_WALL_CLOCK_MS,
            usedSteps: 1,
            usedModelCalls: RUN_MAX_MODEL_CALLS,
            usedTokens: 0,
            elapsedMs: 0,
            startedAt: 0,
          },
        },
        {
          async chat() {
            chats += 1;
            return { choices: [{ message: { content: [{ type: 'text', text: 'no' }] } }] };
          },
        },
      );
      assert(result.ok === false && result.reason === 'budget', result.reason);
      assert(chats === 0, `chats ${chats}`);
    }));

    rows.push(await check('router prompt does not treat plan-and-run as dispatch', async () => {
      const router = readFileSync(new URL('prompts/router.md', root), 'utf8');
      const playbook = readFileSync(new URL('prompts/conductor-playbook/SKILL.md', root), 'utf8');
      assert(router.includes('is not a confirmation'), 'router');
      assert(playbook.includes('is not a confirmation'), 'playbook');
      assert(!router.includes('that is the agreement'), 'router agreement');
      assert(router.includes('confirmToken'), 'token');
    }));

    rows.push(await check('undo deletes comments, never issues', async () => {
      const jira = readFileSync(new URL('src/effects/jira.js', root), 'utf8');
      const deletes = jira.match(/method:\s*'DELETE'/g) || [];
      assert(deletes.length === 1, `delete methods ${deletes.length}`);
      const at = jira.indexOf("method: 'DELETE'");
      const window = jira.slice(Math.max(0, at - 240), at);
      assert(window.includes('/comment/'), 'the only DELETE is a comment');
      assert(jira.includes('Never `DELETE /rest/api/3/issue`'), 'no issue delete');
    }));
  } finally {
    resetStore();
    resetWorkerTypes();
  }
  return rows;
}

/**
 * @param {string} property
 * @param {() => Promise<void>} fn
 * @returns {Promise<SafetyRow>}
 */
async function check(property, fn) {
  try {
    await fn();
    return { property, result: 'PASS', detail: '' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { property, result: 'FAIL', detail };
  }
}

/**
 * @param {unknown} condition
 * @param {string} detail
 */
function assert(condition, detail) {
  if (!condition) {
    throw new Error(detail || 'assertion failed');
  }
}

/**
 * @param {SafetyRow[]} rows
 * @returns {string}
 */
export function formatSafetyReport(rows) {
  const width = Math.max(...rows.map((row) => row.property.length), 'property'.length);
  const lines = [
    `${'property'.padEnd(width)}  result`,
    `${'-'.repeat(width)}  ------`,
  ];
  for (const row of rows) {
    const detail = row.result === 'FAIL' && row.detail ? `  ${row.detail}` : '';
    lines.push(`${row.property.padEnd(width)}  ${row.result}${detail}`);
  }
  const failed = rows.filter((row) => row.result !== 'PASS').length;
  lines.push('');
  lines.push(`${rows.length - failed} pass, ${failed} fail`);
  return lines.join('\n');
}
