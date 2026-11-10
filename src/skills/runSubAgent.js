/**
 * Run one sub-agent step under its brief (WP15).
 *
 * Order of work:
 * 1. Wrap the Jira client so a call outside `brief.allowedTools`, or past
 *    `budget.maxToolCalls`, throws a blocked-step error. Workers never call
 *    `requestJira` themselves. Reads go through this client. Writes stay on
 *    the effects queue, which uses `assumeTrustedRoute` (a raw `route` tag
 *    around a full path is rejected as path manipulation).
 * 2. Run the pack. `procedure: builtin` calls the registered worker.
 *    Anything else runs the checklist procedure, unless a WP11 model runner
 *    returned an object.
 * 3. Validate the output against `outputSchema`. On failure, repair once
 *    and validate again. A second failure blocks the step.
 * 4. Keep a short structured result for `step.output`. Put the full output
 *    on the child-issue comment. The summarize step is the exception: its
 *    stored output keeps `summary` and `decisions`, because write-back reads
 *    those fields and the step has no child issue of its own.
 *
 * @module skills/runSubAgent
 */

import { SkillContractError } from './errors.js';
import { runSkillModel } from './modelHook.js';
import { runChecklist } from './procedures.js';
import { validateWithOneRepair } from './schema.js';

const textEncoder = new TextEncoder();

/**
 * @param {object} ctx
 * @param {import('./types.js').SubAgentBrief} brief
 * @returns {object}
 */
function guardContext(ctx, brief) {
  const allowed = new Set(brief.allowedTools);
  let calls = 0;

  /**
   * @param {string} toolName
   */
  function spend(toolName) {
    if (!allowed.has(toolName)) {
      throw new SkillContractError(
        `Tool "${toolName}" is not in this brief (allowed: ${brief.allowedTools.join(', ') || 'none'})`,
        { code: 'TOOL_NOT_ALLOWED' },
      );
    }
    calls += 1;
    if (calls > brief.budget.maxToolCalls) {
      throw new SkillContractError(
        `Tool budget of ${brief.budget.maxToolCalls} call(s) exceeded`,
        { code: 'BUDGET_EXCEEDED' },
      );
    }
  }

  const jira = ctx.jira || {};
  return {
    ...ctx,
    brief,
    jira: {
      /**
       * @param {string} jql
       * @param {object} [options]
       */
      async searchIssues(jql, options) {
        spend('searchIssues');
        if (typeof jira.searchIssues !== 'function') {
          throw new SkillContractError('searchIssues is not available on this Jira client', {
            code: 'TOOL_NOT_ALLOWED',
          });
        }
        return jira.searchIssues.call(jira, jql, options);
      },
      /**
       * @param {string} issueKey
       */
      async getIssueLinks(issueKey) {
        spend('getIssueLinks');
        if (typeof jira.getIssueLinks !== 'function') {
          throw new SkillContractError('getIssueLinks is not available on this Jira client', {
            code: 'TOOL_NOT_ALLOWED',
          });
        }
        return jira.getIssueLinks.call(jira, issueKey);
      },
    },
  };
}

/**
 * @param {unknown} output
 * @returns {string[]}
 */
function collectArtifacts(output) {
  const record = output !== null && typeof output === 'object'
    ? /** @type {Record<string, any>} */ (output)
    : {};
  const keys = new Set();
  for (const list of [record.issues, record.links, record.blockers, record.artifacts]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item && typeof item === 'object' && typeof item.key === 'string' && item.key) {
        keys.add(item.key);
      }
    }
  }
  return [...keys].slice(0, 20);
}

/**
 * @param {unknown} output
 * @returns {Array<{text: string, type: string}>|undefined}
 */
function collectDecisions(output) {
  const record = output !== null && typeof output === 'object'
    ? /** @type {Record<string, any>} */ (output)
    : {};
  if (!Array.isArray(record.decisions)) return undefined;
  const decisions = [];
  for (const item of record.decisions) {
    const source = typeof item === 'string' ? { text: item } : item;
    if (!source || typeof source !== 'object') continue;
    const text = String(source.text || '').trim().slice(0, 500);
    if (!text) continue;
    const type = typeof source.type === 'string' ? source.type : 'decision';
    decisions.push({ text, type });
  }
  return decisions.length > 0 ? decisions : undefined;
}

/**
 * @param {unknown} output
 * @returns {string}
 */
function summaryText(output) {
  const record = output !== null && typeof output === 'object'
    ? /** @type {Record<string, any>} */ (output)
    : {};
  if (typeof record.summary === 'string' && record.summary.trim()) return record.summary.trim();
  if (typeof record.result === 'string' && record.result.trim()) return record.result.trim();
  if (typeof record.description === 'string' && record.description.trim()) {
    return record.description.trim().slice(0, 500);
  }
  return 'Completed.';
}

/**
 * @param {number} confidence
 * @param {unknown} output
 * @returns {number}
 */
function confidenceFor(output) {
  const record = output !== null && typeof output === 'object'
    ? /** @type {Record<string, any>} */ (output)
    : {};
  if (typeof record.confidence === 'number' && Number.isFinite(record.confidence)) {
    return Math.min(1, Math.max(0, record.confidence));
  }
  if (Array.isArray(record.issues)) {
    return record.issues.length > 0 ? 0.8 : 0.4;
  }
  return 0.6;
}

/**
 * @param {object} value
 * @returns {number}
 */
function byteLength(value) {
  return textEncoder.encode(JSON.stringify(value)).length;
}

/**
 * @param {object} args
 * @param {import('./types.js').SkillPack} args.skill
 * @param {import('./types.js').SubAgentBrief} args.brief
 * @param {unknown} args.output
 * @param {boolean} args.repaired
 * @returns {import('./types.js').ShortResult}
 */
export function toShortResult({ skill, brief, output, repaired }) {
  const text = summaryText(output);
  /** @type {import('./types.js').ShortResult} */
  const result = {
    skill: skill.name,
    result: text,
    summary: text,
    confidence: confidenceFor(output),
    artifacts: collectArtifacts(output),
    repaired: Boolean(repaired),
  };
  const record = output !== null && typeof output === 'object'
    ? /** @type {Record<string, any>} */ (output)
    : {};
  if (typeof record.generator === 'string') result.generator = record.generator;
  if (typeof record.model === 'string') result.model = record.model;
  const decisions = collectDecisions(output);
  if (decisions) result.decisions = decisions;

  const cap = brief.budget.maxOutputBytes;
  while (byteLength(result) > cap && result.result.length > 48) {
    result.result = `${result.result.slice(0, Math.max(48, Math.floor(result.result.length * 0.7)))}…`;
    result.summary = result.result;
  }
  if (byteLength(result) > cap) {
    delete result.decisions;
    result.artifacts = result.artifacts.slice(0, 5);
  }
  if (byteLength(result) > cap) {
    result.artifacts = [];
  }
  return result;
}

/**
 * Human-readable full output for the child issue. The stored step does not
 * keep this text.
 *
 * @param {import('./types.js').SkillPack} skill
 * @param {import('./types.js').SubAgentBrief} brief
 * @param {unknown} output
 * @returns {string}
 */
export function renderFullOutput(skill, brief, output) {
  const record = output !== null && typeof output === 'object'
    ? /** @type {Record<string, any>} */ (output)
    : {};
  const lines = [
    `Sub-agent: ${skill.name}`,
    `Objective: ${brief.objective}`,
    `Done when: ${brief.doneWhen}`,
    `Allowed tools: ${brief.allowedTools.join(', ') || 'none'}`,
    '',
  ];
  if (typeof record.description === 'string' && record.description.includes('\n')) {
    lines.push(record.description, '');
  }
  if (typeof record.summary === 'string') {
    lines.push(record.summary, '');
  }
  lines.push('Full output:', JSON.stringify(output, null, 2));
  // Effect payloads share the 64 KiB store cap. Stay well under it.
  return lines.join('\n').slice(0, 30_000);
}

/**
 * @param {Array<object>} effects
 * @param {Record<string, any>} step
 * @param {string} fullText
 * @returns {Array<object>}
 */
function withFullComment(effects, step, fullText) {
  let replaced = false;
  const next = effects.map((effect) => {
    if (replaced || !effect || effect.kind !== 'comment') return effect;
    const payload = { ...(effect.payload || {}), bodyText: fullText };
    delete payload.bodyAdf;
    replaced = true;
    return { ...effect, payload };
  });
  if (replaced) return next;
  const payload = step.childIssueKey
    ? { issueKey: step.childIssueKey, bodyText: fullText }
    : { childOfStepId: step.stepId, bodyText: fullText };
  return next.concat([
    { kind: 'comment', payload, discriminator: 'skill-full-output' },
  ]);
}

/**
 * @param {object} args
 * @param {Record<string, any>} args.step
 * @param {object} args.ctx
 * @param {import('./types.js').SkillPack} args.skill
 * @param {Function|undefined} args.handler
 * @param {import('./types.js').SubAgentBrief} args.brief
 * @returns {Promise<{output: object, effects: Array<object>, fullOutput: any}>}
 */
export async function runSubAgent({ step, ctx, skill, handler, brief }) {
  const guarded = guardContext(ctx, brief);
  /** @type {{output?: any, effects?: Array<object>}} */
  let produced;

  if (skill.procedure === 'builtin') {
    if (typeof handler !== 'function') {
      throw new SkillContractError(
        `Skill "${skill.name}" says procedure builtin but no worker function is registered`,
        { code: 'NO_HANDLER' },
      );
    }
    produced = await handler(step, guarded);
    const checkedBuiltin = validateWithOneRepair(produced?.output ?? {}, skill.outputSchema, {
      fallbackString: brief.objective,
    });
    if (!checkedBuiltin.ok) {
      throw new SkillContractError(
        `Skill "${skill.name}" output failed its schema after one repair: ${checkedBuiltin.errors.join('; ')}`,
        { code: 'SCHEMA_INVALID', details: checkedBuiltin.errors },
      );
    }
    // Keep the worker's own output and effects. Those workers already call
    // the Forge LLM and post an ADF comment. Replacing that comment would
    // drop the citation rules WP11 enforces.
    return {
      output: checkedBuiltin.repaired ? checkedBuiltin.value : produced.output,
      effects: Array.isArray(produced.effects) ? produced.effects : [],
      fullOutput: checkedBuiltin.value,
    };
  }

  const modeled = await runSkillModel({ skill, brief, step, ctx: guarded });
  if (modeled && typeof modeled === 'object') {
    produced = modeled.output && typeof modeled.output === 'object'
      ? modeled
      : { output: modeled, effects: [] };
  } else {
    produced = {
      output: {
        ...runChecklist({ skill, brief, step, run: ctx.run }),
        generator: 'fallback',
        model: null,
      },
      effects: [],
    };
  }

  const full = produced?.output === undefined ? {} : produced.output;
  const checked = validateWithOneRepair(full, skill.outputSchema, {
    fallbackString: brief.objective,
  });
  if (!checked.ok) {
    throw new SkillContractError(
      `Skill "${skill.name}" output failed its schema after one repair: ${checked.errors.join('; ')}`,
      { code: 'SCHEMA_INVALID', details: checked.errors },
    );
  }

  // The closer has no child issue. write-back reads summary and decisions
  // from the stored output, so those fields stay even when they are longer
  // than the sub-agent byte cap.
  if (skill.name === 'summarize' || step.workerType === 'summarize') {
    const record = checked.value && typeof checked.value === 'object' ? checked.value : {};
    return {
      output: {
        workerType: 'summarize',
        summary: typeof record.summary === 'string' ? record.summary : summaryText(record),
        decisions: Array.isArray(record.decisions) ? record.decisions : [],
        stepCount: record.stepCount,
        completedAt: record.completedAt,
        skill: skill.name,
        repaired: checked.repaired,
      },
      effects: [],
      fullOutput: checked.value,
    };
  }

  const short = toShortResult({
    skill,
    brief,
    output: checked.value,
    repaired: checked.repaired,
  });
  const effects = withFullComment(
    Array.isArray(produced?.effects) ? produced.effects : [],
    step,
    renderFullOutput(skill, brief, checked.value),
  );
  return { output: short, effects, fullOutput: checked.value };
}
