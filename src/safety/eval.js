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

import { dispatchRun, forkRun, getRunStatus, planSplit } from '../actions/index.js';
import { handoffGoal } from '../actions/handoff.js';
import { enqueueEffect, effectApplierHandler, configureEffects, resetEffectDependencies } from '../effects/index.js';
import { planCompensations } from '../blast/preview.js';
import {
  applyBudgetStop,
  noteBudgetStop,
  resetBudgetStops,
  RUN_MAX_MODEL_CALLS,
  RUN_WALL_CLOCK_MS,
} from '../run/budget.js';
import { startRun } from '../run/stateMachine.js';
import {
  approveFromPanel,
  authorizeDispatch,
  authorizeFork,
  CONFIRM_TTL_MS,
  issueDispatchGrant,
  issueForkGrant,
  issueHumanConfirmation,
  resetConfirmationGrants,
} from './grants.js';
import { confirmationToken } from './guard.js';
import { createMemoryStore, resetStore, setStore } from '../store/index.js';
import { resetWorkerTypes } from '../worker/index.js';
import { completeText } from '../worker/llm.js';
import { runFailureScenarios } from './failures.js';

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

    rows.push(await check('plan-split does not return confirmToken', async () => {
      assert(planned.confirmToken === undefined, 'plan token');
      assert(!Object.prototype.hasOwnProperty.call(planned, 'confirmToken'), 'plan key');
      assert(!JSON.stringify(planned).includes('v2.'), 'plan hmac');
      const status = await getRunStatus({ runId: planned.runId });
      assert(status.confirmToken === undefined, 'status token');
      assert(!JSON.stringify(status).includes('v2.'), 'status hmac');
    }));

    rows.push(await check('the string "true" is not confirmation', async () => {
      const refused = await dispatchRun({
        runId: planned.runId,
        confirm: 'true',
        acknowledgeBlastRadius: planned.acknowledgement,
        confirmToken: 'v2.' + 'ab'.repeat(16) + '.' + 'cd'.repeat(32),
      }, {}, overrides);
      assert(refused.ok === false && refused.code === 'CONFIRMATION_REQUIRED', refused.error);
      assert((await store.getRun(planned.runId)).status === 'planning', 'status');
    }));

    rows.push(await check('a wrong acknowledgement is rejected', async () => {
      const refused = await dispatchRun({
        runId: planned.runId,
        confirm: true,
        acknowledgeBlastRadius: '0 points, 0 issues, 0 transitions, 0 field changes',
        confirmToken: confirmationToken(planned.blastRadius),
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

    rows.push(await check('a public card digest is not a token', async () => {
      const refused = await dispatchRun({
        runId: planned.runId,
        confirm: true,
        acknowledgeBlastRadius: planned.acknowledgement,
        confirmToken: confirmationToken(planned.blastRadius),
      }, {}, overrides);
      assert(refused.ok === false && refused.code === 'CONFIRMATION_REQUIRED', refused.error);
      assert((await store.getRun(planned.runId)).status === 'planning', 'status');
    }));

    rows.push(await check('a panel grant is single-use and expires', async () => {
      const now = 1_700_000_000_000;
      const first = issueDispatchGrant(planned.blastRadius, { now, principal: 'person' });
      const ok = authorizeDispatch({
        confirm: true,
        acknowledgeBlastRadius: first.acknowledgement,
        confirmToken: first.confirmToken,
      }, planned.blastRadius, now);
      assert(ok.ok === true, ok.reason);
      const again = authorizeDispatch({
        confirm: true,
        acknowledgeBlastRadius: first.acknowledgement,
        confirmToken: first.confirmToken,
      }, planned.blastRadius, now);
      assert(again.ok === false && /already used/.test(again.reason), again.reason);
      const fresh = issueDispatchGrant(planned.blastRadius, { now, principal: 'person' });
      const late = authorizeDispatch({
        confirm: true,
        acknowledgeBlastRadius: fresh.acknowledgement,
        confirmToken: fresh.confirmToken,
      }, planned.blastRadius, now + CONFIRM_TTL_MS);
      assert(late.ok === false && /expired/.test(late.reason), late.reason);
      const forkDigest = issueForkGrant({
        runId: planned.runId,
        stepIdx: 0,
        now,
        principal: 'person',
      });
      const forkOk = authorizeFork({
        runId: planned.runId,
        stepIdx: 0,
        confirm: true,
        acknowledgeBlastRadius: forkDigest.acknowledgement,
        confirmToken: forkDigest.confirmToken,
      }, now);
      assert(forkOk.ok === true, forkOk.reason);
      const forkAgain = authorizeFork({
        runId: planned.runId,
        stepIdx: 0,
        confirm: true,
        acknowledgeBlastRadius: forkDigest.acknowledgement,
        confirmToken: forkDigest.confirmToken,
      }, now);
      assert(forkAgain.ok === false, forkAgain.reason);
    }));

    rows.push(await check('startRun without a grant enqueues nothing', async () => {
      const before = enqueued.length;
      const bare = await startRun(planned.runId, overrides);
      assert(bare.refusedConfirmation?.code === 'CONFIRMATION_REQUIRED', bare.status);
      assert((await store.getRun(planned.runId)).status === 'planning', 'status');
      assert(enqueued.length === before, 'enqueued');
    }));

    rows.push(await check('the Run panel starts the run and does not return the token', async () => {
      const before = enqueued.length;
      const approved = await approveFromPanel({
        runId: planned.runId,
        accountId: 'person-1',
        now: () => 1_700_000_000_000,
        store,
        dispatch: (payload) => dispatchRun(payload, {}, overrides),
      });
      assert(approved.ok === true && approved.status === 'running', approved.error || approved.status);
      assert(approved.confirmToken === undefined, 'panel token');
      assert(!JSON.stringify(approved).includes('v2.'), 'panel hmac');
      assert(enqueued.length > before, 'enqueued');
      const nobody = await approveFromPanel({
        runId: planned.runId,
        accountId: '',
        now: () => 1_700_000_000_000,
        store,
        dispatch: (payload) => dispatchRun(payload, {}, overrides),
      });
      assert(nobody.ok === false && nobody.code === 'CONFIRMATION_REQUIRED', nobody.error);
    }));

    rows.push(await check('a matching panel grant is the only path that enqueues', async () => {
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
      assert(handed.confirmToken === undefined, 'handoff token');
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
      const stopped = await approveFromPanel({
        runId: late.runId,
        accountId: 'person-1',
        now: () => 1_700_000_000_000,
        store,
        dispatch: (payload) => dispatchRun(payload, {}, overrides),
      });
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

    rows.push(await check('a budget stop drains a pending effect before Jira', async () => {
      const held = await planSplit({
        epicKey: 'PAY-1',
        projectKey: 'PAY',
        goal: 'Drain refunds',
        steps: [{ title: 'Research refunds', workerType: 'research', input: 'refunds' }],
      });
      let jiraCalls = 0;
      configureEffects({
        store,
        queue: { async push() { return { jobId: 'drain' }; } },
        requestJira: async () => {
          jiraCalls += 1;
          return { status: 201, ok: true, json: async () => ({ key: 'PAY-9' }) };
        },
        now: () => 1_700_000_000_000,
      });
      const queued = await enqueueEffect({
        runId: held.runId,
        kind: 'createIssue',
        payload: {
          projectKey: 'PAY',
          parentKey: 'PAY-1',
          summary: 'should not land',
          issueType: 'Sub-task',
        },
        discriminator: 'budget-drain',
      }, { store });
      const storedRun = await store.getRun(held.runId);
      await applyBudgetStop(store, storedRun, {
        reason: 'wall-clock',
        budget: { ...storedRun.budget, elapsedMs: RUN_WALL_CLOCK_MS + 1 },
      });
      const drained = await effectApplierHandler({ body: { requestKey: queued.requestKey } });
      assert(drained.status === 'failed', drained?.status);
      assert(drained.result?.cancelled === true, 'cancelled');
      assert(jiraCalls === 0, `jira ${jiraCalls}`);
      const second = await enqueueEffect({
        runId: held.runId,
        kind: 'comment',
        payload: { issueKey: 'PAY-1', bodyText: 'late' },
        discriminator: 'budget-late-comment',
      }, { store });
      noteBudgetStop(held.runId);
      const lateEffect = await effectApplierHandler({ body: { requestKey: second.requestKey } });
      assert(lateEffect.status === 'failed', lateEffect?.status);
      assert(jiraCalls === 0, `jira after note ${jiraCalls}`);
    }));

    rows.push(await check('setFields records prior values and restoreFields writes them back', async () => {
      const issue = { key: 'PAY-1', fields: { summary: 'Refunds' } };
      configureEffects({
        store,
        queue: { async push() { return { jobId: 'fields' }; } },
        requestJira: async (_path, init = {}) => {
          const method = init.method || 'GET';
          if (method === 'GET') {
            return {
              status: 200,
              ok: true,
              json: async () => JSON.parse(JSON.stringify(issue)),
            };
          }
          const body = JSON.parse(init.body);
          Object.assign(issue.fields, body.fields);
          return { status: 204, ok: true, json: async () => ({}) };
        },
        now: () => 1_700_000_000_000,
      });
      const run = await store.createRun({
        epicKey: 'PAY-1',
        projectKey: 'PAY',
        goal: 'Edit the summary',
        createdBy: 'person',
      });
      const [step] = await store.createSteps(run.runId, [
        { title: 'Edit summary', workerType: 'research', input: 'summary' },
      ]);
      const queued = await enqueueEffect({
        runId: run.runId,
        stepId: step.stepId,
        kind: 'setFields',
        payload: { issueKey: 'PAY-1', fields: { summary: 'Refunds v2' } },
        discriminator: 'fields:summary',
      }, { store });
      const applied = await effectApplierHandler({ body: { requestKey: queued.requestKey } });
      assert(applied.status === 'applied', applied?.status);
      assert(applied.result.before.fields.summary === 'Refunds', 'before');
      assert(issue.fields.summary === 'Refunds v2', 'written');
      const plan = planCompensations([applied]);
      const restore = plan.compensations.find((item) => item.kind === 'restoreFields');
      assert(restore, `no restore: ${JSON.stringify(plan.cannotUndo)}`);
      const undone = await enqueueEffect({
        runId: restore.runId,
        stepId: restore.stepId || undefined,
        kind: restore.kind,
        payload: restore.payload,
        discriminator: restore.discriminator,
      }, { store });
      const restored = await effectApplierHandler({ body: { requestKey: undone.requestKey } });
      assert(restored.status === 'applied', restored?.status);
      assert(restored.result?.skipped !== true, restored.result?.reason || 'skipped');
      assert(issue.fields.summary === 'Refunds', 'restored');
    }));

    rows.push(await check('router prompt does not treat plan-and-run as dispatch', async () => {
      const router = readFileSync(new URL('prompts/router.md', root), 'utf8');
      const playbook = readFileSync(new URL('prompts/conductor-playbook/SKILL.md', root), 'utf8');
      assert(router.includes('is not a confirmation'), 'router');
      assert(playbook.includes('is not a confirmation'), 'playbook');
      assert(!router.includes('that is the agreement'), 'router agreement');
      assert(router.includes('confirmToken'), 'token');
      assert(router.includes('Run panel'), 'panel');
      assert(router.includes('does not return one'), 'omitted');
      assert(!router.includes('returned `confirmToken`'), 'copied token');
    }));

    rows.push(...await runFailureScenarios());

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
    resetEffectDependencies();
    resetConfirmationGrants();
    resetBudgetStops();
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
