/**
 * The call sequence another agent uses to hand a goal to Ticket Conductor.
 *
 * `conductor-router` is the supervisor a person talks to. This module is
 * the other side of that: a second Rovo agent, a Rovo Studio agent, or an
 * MCP client (Cursor, Claude) that already has a goal and wants a run.
 *
 * The sequence inside this function stops before any Jira enqueue:
 *
 * 1. `recall-memory` (read-only) so the plan can follow a stored decision.
 * 2. `plan-split` stores the run at status `planning` and returns
 *    `acknowledgement`. It does not return `confirmToken`. No Jira write.
 *
 * A `confirm` flag on this same call is ignored. This function does not
 * receive a token, and it does not mint one. The person approves on the
 * Run panel. Rovo may still show its own card for `dispatch-run`. The
 * card is not the check.
 *
 * Nothing in this file calls Jira. `overrides` is the dependency bag the
 * caller will pass to the later `dispatch-run`.
 *
 * @module actions/handoff
 */

import { StoreValidationError } from '../store/index.js';
import {
  planSplit,
  recallMemory,
} from './index.js';

/**
 * A three-step plan used when a demo caller did not supply `stepsJson`.
 * The input of each step is the goal text. Worker types are the three
 * types the supervisor is allowed to put in a plan. `dependsOn` makes
 * this a chain: research, then the spec, then the dependency check.
 * `summarize` is left out; the run adds that step itself when the others
 * finish.
 *
 * @param {string} goal
 * @returns {string} JSON array string suitable for `plan-split`.
 */
export function defaultStepsJson(goal) {
  return JSON.stringify([
    {
      title: 'Find related issues',
      workerType: 'research',
      input: goal,
      dependsOn: [],
    },
    {
      title: 'Draft the spec',
      workerType: 'draft-spec',
      input: goal,
      dependsOn: [0],
    },
    {
      title: 'Check dependencies',
      workerType: 'check-deps',
      input: goal,
      dependsOn: [1],
    },
  ]);
}

/**
 * @param {unknown} error
 * @returns {{message: string, code: string}}
 */
function describeError(error) {
  if (error instanceof Error) {
    const code = /** @type {{code?: string}} */ (error).code;
    return {
      message: error.message,
      code: typeof code === 'string' && code.length > 0 ? code : 'ERROR',
    };
  }
  return { message: String(error), code: 'ERROR' };
}

/**
 * Hand one goal to Conductor and read the status back.
 *
 * On a validation failure the function stops at that tool and does not
 * call the later ones. A failed `plan-split` therefore never dispatches.
 * `recall-memory` failing is reported before any run exists.
 *
 * @param {Record<string, unknown>} input `epicKey`, `goal`, and either
 *   `stepsJson` (string) or `steps` (array, tests only). `projectKey` is
 *   optional when the Epic key has a project prefix.
 * @param {Record<string, unknown>} [context] Forge invocation context.
 *   `accountId` is read from here, never from the goal text.
 * @param {object} [overrides] Passed only to `dispatchRun` / `startRun`.
 *   Tests pass an in-memory store and stub queues.
 * @returns {Promise<{ok: boolean, stage?: string, runId?: string, status?: string|null, calls: Array<object>, error?: string, code?: string, run?: object|null, steps?: object[]}>}
 */
export async function handoffGoal(input, context, overrides) {
  const source = input && typeof input === 'object' ? input : {};
  if (typeof source.epicKey !== 'string' || source.epicKey.trim().length === 0) {
    throw new StoreValidationError('epicKey is required');
  }
  if (typeof source.goal !== 'string' || source.goal.trim().length === 0) {
    throw new StoreValidationError('goal is required');
  }

  const epicKey = source.epicKey.trim();
  const goal = source.goal.trim();
  const projectKey = typeof source.projectKey === 'string'
    ? source.projectKey.trim()
    : '';
  const stepsJson = source.steps !== undefined ? source.steps : source.stepsJson;
  /** @type {Array<{tool: string, arguments: Record<string, unknown>, result: object}>} */
  const calls = [];

  // 1. Recall is read-only. An empty list is a successful result.
  let recalled;
  try {
    const recallArgs = {
      projectKey: projectKey || epicKey.split('-')[0],
      query: goal,
    };
    recalled = await recallMemory(recallArgs);
    calls.push({ tool: 'recall-memory', arguments: recallArgs, result: recalled });
  } catch (error) {
    const described = describeError(error);
    return {
      ok: false,
      stage: 'recall-memory',
      calls,
      error: described.message,
      code: described.code,
    };
  }

  // 2. Persist the plan. No child issues yet.
  let planned;
  try {
    const planArgs = {
      epicKey,
      goal,
      stepsJson,
      ...(projectKey ? { projectKey } : {}),
    };
    planned = await planSplit(planArgs, context);
    calls.push({ tool: 'plan-split', arguments: planArgs, result: planned });
  } catch (error) {
    const described = describeError(error);
    return {
      ok: false,
      stage: 'plan-split',
      calls,
      error: described.message,
      code: described.code,
    };
  }

  if (!planned || planned.ok === false || typeof planned.runId !== 'string') {
    return {
      ok: false,
      stage: 'plan-split',
      calls,
      error: planned?.error || 'plan-split did not return a runId',
      code: planned?.code || 'ERROR',
    };
  }

  // 3. Do not dispatch from this function. plan-split did not return a
  // token, so this call cannot start the run. A `confirm` flag on this
  // same call is ignored. The person approves on the Run panel.
  void overrides;
  return {
    ok: true,
    awaitingConfirmation: true,
    stage: 'plan-split',
    runId: planned.runId,
    status: 'planning',
    acknowledgement: planned.acknowledgement,
    blastRadius: planned.blastRadius,
    calls,
  };
}
