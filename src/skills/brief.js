/**
 * Sub-agent briefs (WP15).
 *
 * A brief is the only context a step worker is supposed to need:
 * objective, the tools it may call, the condition that means "done", and a
 * budget. The Router does not write this. `plan-split` and `startRun` build
 * it from the skill pack plus the step title and the Epic goal.
 *
 * A plan may narrow the brief (fewer tools, a tighter byte cap) by sending
 * an object `input`. It cannot widen it: a tool the pack does not list is
 * dropped, and the output cap cannot go above 2048 bytes. Repair attempts
 * are always 1. The playbook asks the Router to send `input` as a string,
 * which does not override the pack.
 *
 * Briefs read `step.dependsOn` and `step.dependencyContext` from the graph.
 * Checklist packs call `@forge/llm`. The checklist runs when that call is unavailable.
 *
 * @module skills/brief
 */

import { tryLoadSkill } from './library.js';

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampInt(value, min, max, fallback) {
  const number = Number.isInteger(value) ? value : fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * Graph indexes. Only `step.dependsOn` counts. A copy inside `input` is not
 * the scheduler's list.
 *
 * @param {Record<string, any>} step
 * @returns {number[]}
 */
function stepDependsOn(step) {
  if (!Array.isArray(step.dependsOn)) return [];
  return step.dependsOn.filter((index) => Number.isInteger(index) && index >= 0);
}

/**
 * One short line from `step.dependencyContext`. The full context stays on
 * the step. The brief only quotes it so the objective and the panel can
 * show what the upstream steps already returned.
 *
 * @param {Record<string, any>} step
 * @returns {string}
 */
function upstreamLine(step) {
  const context = Array.isArray(step.dependencyContext) ? step.dependencyContext : [];
  if (context.length === 0) return '';
  return context.slice(0, 4).map((entry) => {
    const output = entry?.output;
    const record = output !== null && typeof output === 'object' ? output : {};
    const summary = typeof record.summary === 'string'
      ? record.summary
      : typeof record.result === 'string'
        ? record.result
        : '';
    const text = String(summary || entry?.title || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    return `${entry?.idx ?? '?'}: ${text}`;
  }).join('; ');
}

/**
 * @param {import('../store/types.js').Step|Record<string, any>} step
 * @param {import('../store/types.js').Run|Record<string, any>|null|undefined} run
 * @returns {string}
 */
function defaultObjective(step, run) {
  const goal = run && typeof run.goal === 'string' ? run.goal.trim() : '';
  const title = typeof step.title === 'string' ? step.title.trim() : '';
  if (title && goal) return `${title}. Goal: ${goal}`;
  return title || goal || 'Complete the step.';
}

/**
 * Brief used when the step has no skill pack (a test worker, or the packs
 * directory is not on disk). The step still gets the four fields.
 *
 * @param {import('../store/types.js').Step|Record<string, any>} step
 * @param {import('../store/types.js').Run|Record<string, any>|null|undefined} [run]
 * @returns {import('./types.js').SubAgentBrief}
 */
export function fallbackBrief(step, run) {
  return {
    objective: defaultObjective(step, run),
    allowedTools: [],
    doneWhen: 'The worker returns an output object.',
    budget: {
      maxToolCalls: 4,
      maxOutputBytes: 2048,
      maxRepairAttempts: 1,
    },
    dependsOn: stepDependsOn(step),
  };
}

/**
 * Build the brief for one step from its pack.
 *
 * @param {object} args
 * @param {import('./types.js').SkillPack} args.skill
 * @param {import('../store/types.js').Step|Record<string, any>} args.step
 * @param {import('../store/types.js').Run|Record<string, any>|null|undefined} [args.run]
 * @returns {import('./types.js').SubAgentBrief}
 */
export function buildBrief({ skill, step, run }) {
  const input = asRecord(step.input);
  let objective = typeof input.objective === 'string' && input.objective.trim()
    ? input.objective.trim()
    : defaultObjective(step, run);

  const packTools = Array.isArray(skill.tools) ? skill.tools : [];
  const allowedTools = Array.isArray(input.allowedTools)
    ? input.allowedTools.filter((tool) => packTools.includes(tool))
    : packTools.slice();

  const doneWhen = typeof input.doneWhen === 'string' && input.doneWhen.trim()
    ? input.doneWhen.trim()
    : skill.doneWhen;

  const dependsOn = stepDependsOn(step);
  const upstream = upstreamLine(step);
  if (dependsOn.length > 0) {
    objective += ` Depends on steps ${dependsOn.join(', ')}.`;
  }
  if (upstream) {
    objective += ` Upstream: ${upstream}.`;
  }

  const requested = asRecord(input.budget);
  const packBudget = skill.budget || {};
  return {
    objective,
    allowedTools,
    doneWhen,
    budget: {
      maxToolCalls: clampInt(requested.maxToolCalls, 0, 20, packBudget.maxToolCalls ?? 4),
      // 2048 bytes is the short-result cap from the super-agent doc ("≤ 2 KB").
      maxOutputBytes: clampInt(
        requested.maxOutputBytes,
        256,
        2048,
        Math.min(packBudget.maxOutputBytes ?? 2048, 2048),
      ),
      maxRepairAttempts: 1,
    },
    dependsOn,
    ...(upstream ? { upstream } : {}),
  };
}

/**
 * Resolve the pack (if any) and the brief for a step.
 *
 * @param {import('../store/types.js').Step|Record<string, any>} step
 * @param {import('../store/types.js').Run|Record<string, any>|null|undefined} [run]
 * @returns {{skill: string|undefined, brief: import('./types.js').SubAgentBrief, pack: import('./types.js').SkillPack|null}}
 */
export function briefForStep(step, run) {
  // Always rebuild. A waiting step receives `dependencyContext` only when
  // it is released, which is after plan-split stored the first brief.
  // An approval gate has no skill pack and no tools. The person is the
  // thing that finishes it. `prepareStepDraft` leaves the step unchanged
  // when there is no pack, and `startRun` stores this brief.
  if (step?.workerType === 'approval') {
    return {
      skill: undefined,
      brief: {
        objective: `Wait for a person to approve "${typeof step.title === 'string' ? step.title : 'this step'}".`,
        allowedTools: [],
        doneWhen: 'A person approves this gate. The step worker does not complete it.',
        budget: {
          maxToolCalls: 0,
          maxOutputBytes: 2048,
          maxRepairAttempts: 1,
        },
        dependsOn: stepDependsOn(step),
      },
      pack: null,
    };
  }
  const pack = tryLoadSkill(step.skill || step.workerType);
  if (!pack) {
    return { skill: undefined, brief: fallbackBrief(step, run), pack: null };
  }
  return {
    skill: pack.name,
    brief: buildBrief({ skill: pack, step, run }),
    pack,
  };
}

/**
 * Draft for `createSteps`. A pack attaches `skill` and `brief`. A worker
 * type with no pack is returned unchanged so tests can register one-off
 * workers without writing a Markdown file.
 *
 * @param {{title: string, workerType: string, input?: any, skill?: string, brief?: object}} step
 * @param {{goal?: string}} [context]
 * @returns {object}
 */
export function prepareStepDraft(step, context = {}) {
  const prepared = briefForStep(step, { goal: context.goal || '' });
  if (!prepared.pack) {
    return step;
  }
  return {
    ...step,
    skill: prepared.skill,
    brief: prepared.brief,
  };
}
