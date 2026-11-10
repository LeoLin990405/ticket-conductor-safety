/**
 * Stable tool contract for agents other than the Ticket Conductor supervisor.
 *
 * Forge `action` inputs, and the optional `outputs` map, only allow
 * `boolean`, `integer`, `number`, and `string` (Forge CLI 14.2.0 schema,
 * at most 10 properties). A list of steps cannot be one input and cannot be
 * one declared output. Callers send the plan as the string `stepsJson`.
 * Each function returns a JSON object. The shapes in this file are the
 * fields another agent should read.
 *
 * Manifest `outputs` is intentionally unset. On this CLI that property is
 * the Automation smart-value map (`outputContext` is required beside it)
 * and it still cannot describe a step or a memory. Putting a partial map
 * there would advertise a shape the function does not actually return.
 * The long form of this contract lives in
 * `prompts/conductor-tools/references/io.md` and in
 * `docs/spike-rovo-skill-mcp.md`.
 *
 * Action `description` is what another model reads when it decides to call
 * the tool. CLI 14.2.0 caps that string at 255 characters. The strings
 * below are copied verbatim into `manifest.yml`.
 *
 * @module actions/contract
 */

import { readRunBudget } from '../run/budget.js';

/** CLI 14.2.0 `action.description` maxLength. @constant {number} */
export const ACTION_DESCRIPTION_MAX = 255;

/**
 * Descriptions written for a calling agent, not for an end user.
 * Each value must stay within {@link ACTION_DESCRIPTION_MAX}.
 *
 * @constant {Readonly<Record<string, string>>}
 */
export const TOOL_DESCRIPTIONS = Object.freeze({
  'plan-split':
    'Other agents call this to save a Conductor plan. Returns {ok,runId,status,steps,recalledMemories}. stepsJson is JSON text of 1-8 objects {title,workerType,input,dependsOn}. dependsOn is step indexes; a cycle is rejected. No Jira writes.',
  'dispatch-run':
    'Other agents call this to start a saved plan. Input runId from plan-split. Returns {ok,runId,status}. A step starts when every dependsOn index is done; others wait. A repeat call does not enqueue again. No Jira writes.',
  'get-run-status':
    'Other agents call this to read a Conductor run. Pass runId, or epicKey for the latest run. Returns {ok,run,steps}. Each step has idx, title, workerType, status, dependsOn, childIssueKey, attempt. waiting means a dependency is not done. Read-only.',
  'recall-memory':
    'Other agents call this before planning. Returns {ok,memories,skillIndex}. memories stay inside a 1536-byte budget. skillIndex is {name,description} only and is not part of that budget. Read-only.',
});

/**
 * Action keys exposed to other agents (the handoff agent and `rovo:mcp`).
 * `record-decision` stays on the supervisor only.
 *
 * @constant {ReadonlyArray<string>}
 */
export const REUSABLE_TOOL_KEYS = Object.freeze([
  'plan-split',
  'dispatch-run',
  'get-run-status',
  'recall-memory',
]);

/**
 * Supervisor-only flight-recorder actions. Same description rules as
 * {@link TOOL_DESCRIPTIONS} (255 characters, copied into manifest.yml).
 * They are not on `rovo:mcp` or `conductor-tools`.
 *
 * @constant {Readonly<Record<string, string>>}
 */
export const RECORDER_DESCRIPTIONS = Object.freeze({
  'replay-run':
    'Dry-run a saved run against today\'s Jira. Returns {ok,dryRun,duplicateWrites,steps,effects,lessons}. Uses lessons valid at the run createdAt. Names newer lessons in the diff. Writes nothing.',
  'fork-run':
    'Fork a run from one step. Returns {ok,runId,status,forkedFromRunId,copy,rerun}. Re-runs only steps that depend on stepIdx. Optional input edits that step too. Prefix effects are not written again.',
});

/**
 * Copy one stored memory into the fields the tool contract promises.
 * Extra store fields (score inputs, `supersededBy`, `validUntil`) stay
 * inside the store. A caller cannot turn a tool response into a write.
 *
 * @param {import('../store/types.js').Memory} memory
 * @returns {{memId: string, projectKey: string, memType: string, text: string, sourceIssue: string|null, runId: string|null, scope: string|null, confidence: number|null}}
 */
export function publicMemory(memory) {
  return {
    memId: memory.memId,
    projectKey: memory.projectKey,
    memType: memory.memType,
    text: memory.text,
    sourceIssue: memory.sourceIssue ? String(memory.sourceIssue) : null,
    runId: memory.runId ? String(memory.runId) : null,
    scope: memory.scope ? String(memory.scope) : null,
    confidence: typeof memory.confidence === 'number' ? memory.confidence : null,
  };
}

/**
 * One step as `plan-split` returns it, before dispatch has created a child.
 *
 * @param {import('../store/types.js').Step} step
 */
export function publicPlanStep(step) {
  return {
    stepId: step.stepId,
    idx: step.idx,
    title: step.title,
    workerType: step.workerType,
    input: step.input === undefined ? '' : step.input,
    dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn : [],
    skill: step.skill || null,
    brief: step.brief || null,
    status: step.status,
  };
}

/**
 * One step as `get-run-status` returns it.
 * `childIssueKey` is null until the createIssue effect has been applied.
 * The key is always present so a caller does not have to test for a
 * missing property.
 *
 * @param {import('../store/types.js').Step} step
 */
export function publicStatusStep(step) {
  return {
    idx: step.idx,
    title: step.title,
    workerType: step.workerType,
    status: step.status,
    dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn : [],
    childIssueKey: step.childIssueKey ? String(step.childIssueKey) : null,
    attempt: step.attempt,
    skill: step.skill || null,
    brief: step.brief || null,
    wave: Number.isInteger(step.wave) && step.wave > 0 ? step.wave : 1,
  };
}

/**
 * Run fields another agent is allowed to depend on.
 * The entity key (`runId`) is included here because the store does not
 * keep the key as an attribute. `summarizeQueued` is an unused storage
 * attribute and is not part of this contract.
 *
 * @param {import('../store/types.js').Run} run
 */
export function publicRun(run) {
  return {
    runId: run.runId,
    epicKey: run.epicKey,
    projectKey: run.projectKey,
    goal: run.goal,
    status: run.status,
    summary: run.summary === undefined ? null : run.summary,
    createdAt: run.createdAt ?? null,
    updatedAt: run.updatedAt ?? null,
    reviewedThroughWave: Number.isInteger(run.reviewedThroughWave)
      ? run.reviewedThroughWave
      : 0,
    leadAction: run.ledger?.lastDecision?.action || null,
    // Caps and measured usage, copied off the stored run. The critical
    // path and the ETA are computed beside this object by `get-run-status`.
    // They are not fields of `run.budget` and they are not stored.
    // `budget.chaos` is the three proof counters. The reader fills zeros
    // when the row has not stored them yet.
    budget: readRunBudget(run.budget, run.createdAt),
  };
}
