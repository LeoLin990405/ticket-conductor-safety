/**
 * Turn retrieved evidence into step output and one ADF comment (WP11).
 *
 * Each composer asks `@forge/llm` for JSON, then keeps only fields that match
 * the worker's schema. The model cannot add an effect. The comment effect is
 * built here, and its issue key is `step.childIssueKey` (or a deferred
 * `childOfStepId` for the workers that `startRun` creates a child issue for).
 *
 * When the model is unavailable, or its JSON cannot be used, the composer
 * returns the same deterministic text the MVP workers produced. Tests and a
 * site that has not consented to the `llm` module still finish a run.
 *
 * @module worker/content
 */

import {
  bulletList,
  doc,
  heading,
  paragraph,
  sourceLabel,
  sourceLine,
  textNode,
} from './adf.js';
import {
  acceptFindings,
  acceptRisks,
  clip,
  parseModelJson,
  stringList,
} from './guard.js';
import { completeText } from './llm.js';
import {
  depsUserPrompt,
  draftUserPrompt,
  researchUserPrompt,
  summarizeUserPrompt,
  SYSTEM_PROMPT,
} from './prompts.js';
import { gatherResearch, loadUpstream, normalizeLinks } from './sources.js';
import { MEMORY_TYPES } from '../store/index.js';

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
 * The only Jira effect a built-in worker may return.
 *
 * `issueKey` is copied from the step record. It is not read from model JSON.
 * `defer` is false for the automatic summarize step: that step has no child
 * issue, and a deferred comment would wait on the effect queue forever.
 *
 * @param {import('../store/types.js').Step} step
 * @param {string} bodyText
 * @param {object} bodyAdf
 * @param {string} discriminator
 * @param {{defer?: boolean}} [options]
 * @returns {Array<Record<string, any>>}
 */
export function commentEffect(step, bodyText, bodyAdf, discriminator, options = {}) {
  const defer = options.defer !== false;
  if (!step.childIssueKey && !defer) {
    return [];
  }
  /** @type {Record<string, unknown>} */
  const payload = { bodyText, bodyAdf };
  if (step.childIssueKey) {
    payload.issueKey = step.childIssueKey;
  } else {
    payload.childOfStepId = step.stepId;
  }
  return [
    {
      kind: 'comment',
      payload,
      discriminator,
    },
  ];
}

/**
 * The transition the blast-radius card already lists when a step sets
 * `input.transitionTo`.
 *
 * Built-in workers do not invent transitions. This returns nothing unless
 * the plan named a destination, so a run that never set the field enqueues
 * the same effects it did before. The discriminator is `transition:<status>`,
 * the same string `plannedRequestKey` uses, so the card and the effect share
 * one request key.
 *
 * `transitionTarget: 'epic'` aims at the run's Epic. `transitionIssueKey`
 * aims at that issue. Otherwise the target is this step's child. Undo of a
 * child transition is covered by closing the child. Undo of an Epic (or any
 * issue this run did not create) is `restoreStatus`.
 *
 * @param {import('../store/types.js').Step} step
 * @param {{epicKey?: string}|null|undefined} run
 * @returns {Array<Record<string, any>>}
 */
export function transitionEffect(step, run) {
  const input = step?.input && typeof step.input === 'object' && !Array.isArray(step.input)
    ? /** @type {Record<string, unknown>} */ (step.input)
    : {};
  const toStatusName = typeof input.transitionTo === 'string' ? input.transitionTo.trim() : '';
  if (toStatusName.length === 0) {
    return [];
  }
  let issueKey = '';
  if (input.transitionTarget === 'epic') {
    issueKey = typeof run?.epicKey === 'string' ? run.epicKey : '';
  } else if (typeof input.transitionIssueKey === 'string' && input.transitionIssueKey.length > 0) {
    issueKey = input.transitionIssueKey;
  } else if (typeof step?.childIssueKey === 'string') {
    issueKey = step.childIssueKey;
  }
  if (issueKey.length === 0) {
    return [];
  }
  return [
    {
      kind: 'transition',
      payload: { issueKey, toStatusName },
      discriminator: `transition:${toStatusName}`,
    },
  ];
}

/**
 * The field edit the blast-radius card lists when a step sets
 * `input.fields`. Only string, number, boolean, and null values are
 * written. The discriminator is `fields:` plus the names sorted, the same
 * string `plannedRequestKey` uses when every value is a scalar.
 *
 * `fieldsTarget: 'epic'` aims at the run's Epic. `fieldsIssueKey` aims at
 * that issue. Otherwise the target is this step's child. Undo of a child
 * edit is covered by closing the child. Undo of any other issue is
 * `restoreFields`, using the previous values the applier stored.
 *
 * @param {import('../store/types.js').Step} step
 * @param {{epicKey?: string}|null|undefined} run
 * @returns {Array<Record<string, any>>}
 */
export function fieldEffect(step, run) {
  const input = step?.input && typeof step.input === 'object' && !Array.isArray(step.input)
    ? /** @type {Record<string, unknown>} */ (step.input)
    : {};
  const raw = input.fields;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  /** @type {Record<string, string|number|boolean|null>} */
  const fields = {};
  for (const name of Object.keys(raw).sort()) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) continue;
    const value = raw[name];
    if (value === null || typeof value === 'boolean') {
      fields[name] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      fields[name] = value;
    } else if (typeof value === 'string') {
      fields[name] = value.length > 500 ? value.slice(0, 500) : value;
    }
  }
  const names = Object.keys(fields);
  if (names.length === 0) return [];
  let issueKey = '';
  if (input.fieldsTarget === 'epic') {
    issueKey = typeof run?.epicKey === 'string' ? run.epicKey : '';
  } else if (typeof input.fieldsIssueKey === 'string' && input.fieldsIssueKey.length > 0) {
    issueKey = input.fieldsIssueKey;
  } else if (typeof step?.childIssueKey === 'string') {
    issueKey = step.childIssueKey;
  }
  if (issueKey.length === 0) return [];
  return [
    {
      kind: 'setFields',
      payload: { issueKey, fields },
      discriminator: `fields:${names.join(',')}`,
    },
  ];
}

/**
 * Chaos checkpoint. Production workers do not have `ctx.faultCheckpoint`,
 * so this returns null and the caller does not await anything. The step
 * worker installs the hook only when fault injection is enabled, and the
 * hook throws after the worker has already read its evidence.
 *
 * @param {any} ctx
 * @param {string} at
 * @returns {Promise<void>|null}
 */
function beginFaultCheckpoint(ctx, at) {
  const hook = ctx?.faultCheckpoint;
  if (typeof hook !== 'function') return null;
  return hook(at);
}

/**
 * @param {any} ctx
 * @param {string} kind
 * @param {{ok: boolean, reason?: string}} llm
 */
function noteFallback(ctx, kind, llm) {
  if (llm.ok || llm.reason === 'unavailable' || llm.reason === 'disabled') {
    return;
  }
  if (typeof ctx?.logger?.warn === 'function') {
    ctx.logger.warn(`WP11 ${kind} is using the deterministic fallback (${llm.reason}).`);
  }
}

/**
 * @param {Array<Record<string, any>>} issues
 * @param {Array<Record<string, any>>} pages
 * @returns {Array<Record<string, any>>}
 */
function fallbackFindings(issues, pages) {
  return [
    ...issues.slice(0, 8).map((issue) => ({
      source: 'jira',
      key: issue.key,
      title: issue.summary,
      url: issue.url || '',
      why: issue.excerpt || issue.summary || issue.status || 'Related issue.',
    })),
    ...pages.slice(0, 5).map((page) => ({
      source: 'confluence',
      key: page.id || page.title,
      title: page.title,
      url: page.url || '',
      why: page.excerpt || page.title || 'Related page.',
    })),
  ];
}

/**
 * @param {Record<string, any>} output
 * @returns {string}
 */
function renderResearchText(output) {
  const lines = ['Research', '', output.summary];
  if (output.findings.length > 0) {
    lines.push('', 'Findings:');
    for (const finding of output.findings) {
      const where = finding.url ? `${finding.key} (${finding.url})` : finding.key;
      lines.push(`- ${where}: ${finding.title} — ${finding.why}`);
    }
  }
  if (output.gaps.length > 0) {
    lines.push('', 'Gaps:');
    for (const gap of output.gaps) {
      lines.push(`- ${gap}`);
    }
  }
  lines.push('', sourceLine(output));
  return lines.join('\n');
}

/**
 * @param {Record<string, any>} output
 * @returns {object}
 */
function renderResearchAdf(output) {
  /** @type {object[]} */
  const blocks = [
    heading(2, 'Research'),
    paragraph([textNode(output.summary)]),
  ];
  if (output.findings.length > 0) {
    blocks.push(heading(3, 'Findings'));
    blocks.push(bulletList(output.findings.map((finding) => [
      sourceLabel(finding.key, finding.url),
      textNode(finding.title ? ` ${finding.title}` : ''),
      textNode(finding.why ? ` — ${finding.why}` : ''),
    ])));
  }
  if (output.gaps.length > 0) {
    blocks.push(heading(3, 'Gaps'));
    blocks.push(bulletList(output.gaps.map((gap) => [textNode(gap)])));
  }
  blocks.push(paragraph([textNode(sourceLine(output))]));
  return doc(blocks);
}

/**
 * @param {import('../store/types.js').Step} step
 * @param {any} ctx
 * @returns {Promise<{output: object, effects: Array<object>}>}
 */
export async function composeResearch(step, ctx) {
  const gathered = await gatherResearch(step, ctx);
  const killCheckpoint = beginFaultCheckpoint(ctx, 'after-evidence');
  if (killCheckpoint) await killCheckpoint;
  const findings = fallbackFindings(gathered.issues, gathered.pages);
  let summary = gathered.issues.length === 0
    ? `No related issues found for "${step.title}".`
    : `Found ${gathered.issues.length} related issue(s): ${gathered.issues
        .slice(0, 5)
        .map((issue) => `${issue.key} ${issue.summary}`.trim())
        .join('; ')}.`;
  if (gathered.pages.length > 0) {
    summary += ` ${gathered.pages.length} Confluence page(s): ${gathered.pages
      .slice(0, 5)
      .map((page) => page.title)
      .filter(Boolean)
      .join('; ')}.`;
  }

  /** @type {Record<string, any>} */
  let output = {
    workerType: 'research',
    jql: gathered.jql,
    cql: gathered.cql,
    confluence: gathered.confluence,
    count: gathered.issues.length,
    pageCount: gathered.pages.length,
    issues: gathered.issues,
    pages: gathered.pages,
    findings,
    gaps: [],
    summary,
    generator: 'fallback',
    model: null,
  };

  const llm = await completeText(
    {
      system: SYSTEM_PROMPT,
      user: researchUserPrompt(step, ctx.run, gathered),
      maxTokens: 1024,
      // Run budget meter. Not `brief.budget`, which caps tool calls.
      meter: ctx.modelMeter,
    },
    ctx.llm,
  );
  noteFallback(ctx, 'research', llm);
  if (llm.ok) {
    const data = parseModelJson(llm.text);
    if (data) {
      // Cited keys keep the model's explanation. Every other retrieved
      // source stays in the comment, so the model cannot hide a page or an
      // issue. Keys that were not retrieved never get in.
      const accepted = acceptFindings(data.findings, gathered.issues, gathered.pages);
      const cited = new Set(accepted.map((finding) => finding.key));
      const uncited = output.findings.filter((finding) => !cited.has(finding.key));
      const modelSummary = clip(data.summary, 1200);
      output = {
        ...output,
        summary: modelSummary || output.summary,
        findings: [...accepted, ...uncited].slice(0, 8),
        gaps: stringList(data.gaps, 5, 300),
        generator: 'llm',
        model: llm.model ?? null,
        usage: llm.usage ?? null,
      };
    }
  }

  const bodyText = renderResearchText(output);
  return {
    output,
    effects: commentEffect(step, bodyText, renderResearchAdf(output), 'research-comment'),
  };
}

/**
 * @param {string} summary
 * @param {string} description
 * @param {string} context
 * @param {string[]} criteria
 * @returns {string}
 */
function legacySpecMarkdown(summary, description, context, criteria) {
  const lines = [`# ${summary}`, '', description];
  if (context) {
    lines.push('', '## Context', context);
  }
  if (criteria.length > 0) {
    lines.push('', '## Acceptance criteria');
    for (const criterion of criteria) {
      lines.push(`- ${criterion}`);
    }
  }
  return lines.join('\n');
}

/**
 * @param {Record<string, any>} output
 * @returns {string}
 */
function specMarkdown(output) {
  const lines = [`# ${output.summary}`, ''];
  if (output.problem) {
    lines.push(output.problem, '');
  }
  if (output.proposal) {
    lines.push('## Proposal', output.proposal, '');
  }
  if (output.context) {
    lines.push('## Context', output.context, '');
  }
  if (output.acceptanceCriteria.length > 0) {
    lines.push('## Acceptance criteria');
    for (const item of output.acceptanceCriteria) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }
  if (output.outOfScope.length > 0) {
    lines.push('## Out of scope');
    for (const item of output.outOfScope) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }
  if (output.openQuestions.length > 0) {
    lines.push('## Open questions');
    for (const item of output.openQuestions) {
      lines.push(`- ${item}`);
    }
  }
  return lines.join('\n').trim();
}

/**
 * @param {Record<string, any>} output
 * @returns {object}
 */
function renderSpecAdf(output) {
  /** @type {object[]} */
  const blocks = [heading(2, output.summary)];
  if (output.problem) {
    blocks.push(paragraph([textNode(output.problem)]));
  }
  if (output.proposal) {
    blocks.push(heading(3, 'Proposal'));
    blocks.push(paragraph([textNode(output.proposal)]));
  }
  if (output.context) {
    blocks.push(heading(3, 'Context'));
    blocks.push(paragraph([textNode(output.context)]));
  }
  if (output.acceptanceCriteria.length > 0) {
    blocks.push(heading(3, 'Acceptance criteria'));
    blocks.push(bulletList(output.acceptanceCriteria.map((item) => [textNode(item)])));
  }
  if (output.outOfScope.length > 0) {
    blocks.push(heading(3, 'Out of scope'));
    blocks.push(bulletList(output.outOfScope.map((item) => [textNode(item)])));
  }
  if (output.openQuestions.length > 0) {
    blocks.push(heading(3, 'Open questions'));
    blocks.push(bulletList(output.openQuestions.map((item) => [textNode(item)])));
  }
  blocks.push(paragraph([textNode(sourceLine(output))]));
  return doc(blocks);
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function criteriaOf(raw) {
  if (Array.isArray(raw)) {
    return raw.map((item) => clip(String(item), 300)).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.length > 0) {
    return [clip(raw, 300)];
  }
  return [];
}

/**
 * Plan criteria stay even when the model omits them or replaces them.
 *
 * @param {string[]} planCriteria
 * @param {string[]} modelCriteria
 * @returns {string[]}
 */
function unionCriteria(planCriteria, modelCriteria) {
  const seen = new Set();
  /** @type {string[]} */
  const merged = [];
  for (const item of [...planCriteria, ...modelCriteria]) {
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    merged.push(item);
    if (merged.length >= 12) {
      break;
    }
  }
  return merged;
}

/**
 * @param {import('../store/types.js').Step} step
 * @param {any} ctx
 * @returns {Promise<{output: object, effects: Array<object>}>}
 */
export async function composeDraft(step, ctx) {
  const input = asRecord(step.input);
  const summary = typeof input.summary === 'string' && input.summary.length > 0
    ? input.summary
    : step.title;
  const description = typeof input.description === 'string' && input.description.length > 0
    ? input.description
    : typeof step.input === 'string' && step.input.trim().length > 0
      ? step.input.trim()
      : `Implement "${step.title}" for the goal: ${ctx.run?.goal ?? ''}`;
  const planCriteria = criteriaOf(
    input.acceptanceCriteria ?? input.acceptance ?? input.criteria,
  );
  const context = typeof input.context === 'string' ? input.context : '';
  const upstream = await loadUpstream(step, ctx);
  const killCheckpoint = beginFaultCheckpoint(ctx, 'after-evidence');
  if (killCheckpoint) await killCheckpoint;
  const markdown = legacySpecMarkdown(summary, description, context, planCriteria);

  /** @type {Record<string, any>} */
  let output = {
    workerType: 'draft-spec',
    summary,
    description: markdown,
    problem: '',
    proposal: description,
    acceptanceCriteria: planCriteria,
    outOfScope: [],
    openQuestions: [],
    context,
    upstreamStepIds: upstream.map((prior) => prior.stepId),
    generator: 'fallback',
    model: null,
  };

  const llm = await completeText(
    {
      system: SYSTEM_PROMPT,
      user: draftUserPrompt(step, ctx.run, upstream),
      maxTokens: 1400,
      // Run budget meter. Not `brief.budget`, which caps tool calls.
      meter: ctx.modelMeter,
    },
    ctx.llm,
  );
  noteFallback(ctx, 'draft-spec', llm);
  if (llm.ok) {
    const data = parseModelJson(llm.text);
    const problem = data ? clip(data.problem, 800) : '';
    const proposal = data ? clip(data.proposal, 1200) : '';
    if (data && (problem || proposal)) {
      const next = {
        ...output,
        summary: clip(data.summary, 200) || summary,
        problem,
        proposal,
        acceptanceCriteria: unionCriteria(planCriteria, stringList(data.acceptanceCriteria, 8, 300)),
        outOfScope: stringList(data.outOfScope, 6, 240),
        openQuestions: stringList(data.openQuestions, 6, 240),
        generator: 'llm',
        model: llm.model ?? null,
        usage: llm.usage ?? null,
      };
      next.description = specMarkdown(next);
      output = next;
    }
  }

  // bodyText matches output.description. The draft-spec tests compare them.
  // The source line lives in the ADF document only.
  return {
    output,
    effects: commentEffect(
      step,
      output.description,
      renderSpecAdf(output),
      'draft-spec-comment',
    ),
  };
}

/**
 * @param {Record<string, any>} output
 * @returns {string}
 */
function renderDepsText(output) {
  const lines = ['Dependencies', '', output.summary];
  if (output.risks.length > 0) {
    lines.push('', 'Risks:');
    for (const risk of output.risks) {
      const who = risk.key ? `${risk.key} ${risk.summary}`.trim() : 'General';
      const status = risk.status ? ` (${risk.status})` : '';
      lines.push(`- ${who}${status}: ${risk.risk}`);
    }
  }
  lines.push('', sourceLine(output));
  return lines.join('\n');
}

/**
 * @param {Record<string, any>} output
 * @returns {object}
 */
function renderDepsAdf(output) {
  /** @type {object[]} */
  const blocks = [
    heading(2, 'Dependencies'),
    paragraph([textNode(output.summary)]),
  ];
  if (output.risks.length > 0) {
    blocks.push(heading(3, 'Risks'));
    blocks.push(bulletList(output.risks.map((risk) => {
      const label = risk.key || 'General';
      const detail = [
        risk.summary ? ` ${risk.summary}` : '',
        risk.status ? ` (${risk.status})` : '',
        risk.risk ? `: ${risk.risk}` : '',
      ].join('');
      return [textNode(label, risk.key ? [{ type: 'code' }] : undefined), textNode(detail)];
    })));
  }
  blocks.push(paragraph([textNode(sourceLine(output))]));
  return doc(blocks);
}

/**
 * @param {import('../store/types.js').Step} step
 * @param {any} ctx
 * @returns {Promise<{output: object, effects: Array<object>}>}
 */
export async function composeDeps(step, ctx) {
  const input = asRecord(step.input);
  const issueKey = typeof input.issueKey === 'string' && input.issueKey.length > 0
    ? input.issueKey
    : step.childIssueKey ?? ctx.run?.epicKey;
  const links = normalizeLinks(await ctx.jira.getIssueLinks(issueKey));
  const killCheckpoint = beginFaultCheckpoint(ctx, 'after-evidence');
  if (killCheckpoint) await killCheckpoint;
  const doneStatuses = new Set(
    Array.isArray(input.doneStatuses)
      ? input.doneStatuses.map((status) => String(status).toLowerCase())
      : ['done', 'closed', 'resolved', 'complete'],
  );
  const blockers = links.filter(
    (link) => !doneStatuses.has(String(link.status).toLowerCase()),
  );
  const summary = links.length === 0
    ? `No linked issues on ${issueKey}.`
    : `${links.length} linked issue(s) on ${issueKey}; ${blockers.length} not done.`;
  const fallbackRisks = blockers.map((link) => ({
    key: link.key,
    summary: link.summary,
    status: link.status,
    risk: `${link.key} is ${link.status || 'not done'}${link.type ? ` (${link.type})` : ''}.`,
  }));

  /** @type {Record<string, any>} */
  let output = {
    workerType: 'check-deps',
    issueKey,
    count: links.length,
    links,
    blockers,
    risks: fallbackRisks,
    summary,
    generator: 'fallback',
    model: null,
  };

  const llm = await completeText(
    {
      system: SYSTEM_PROMPT,
      user: depsUserPrompt(step, ctx.run, issueKey, links),
      maxTokens: 800,
      // Run budget meter. Not `brief.budget`, which caps tool calls.
      meter: ctx.modelMeter,
    },
    ctx.llm,
  );
  noteFallback(ctx, 'check-deps', llm);
  if (llm.ok) {
    const data = parseModelJson(llm.text);
    if (data) {
      const risks = acceptRisks(data.risks, links);
      const modelSummary = clip(data.summary, 800);
      output = {
        ...output,
        // Keep the deterministic sentence so "N not done" stays visible, then
        // the model's explanation.
        summary: modelSummary ? `${summary} ${modelSummary}` : summary,
        risks: risks.length > 0 ? risks : fallbackRisks,
        generator: 'llm',
        model: llm.model ?? null,
        usage: llm.usage ?? null,
      };
    }
  }

  return {
    output,
    effects: commentEffect(step, renderDepsText(output), renderDepsAdf(output), 'check-deps-comment'),
  };
}

/**
 * @param {import('../store/types.js').Step} step
 * @returns {string}
 */
function summarizeStepOutput(step) {
  const output = asRecord(step.output);
  const candidate = output.summary
    ?? output.description
    ?? output.text
    ?? output.note
    ?? (Array.isArray(output.issues) ? `${output.issues.length} related issue(s)` : '');
  const text = clip(typeof candidate === 'string' ? candidate : String(candidate ?? ''), 180)
    || 'completed';
  return `- ${step.title}: ${text}`;
}

/**
 * Decisions already stored on completed steps. Unknown types stay `decision`,
 * matching the MVP collector WP6 tests rely on.
 *
 * @param {Array<import('../store/types.js').Step>} steps
 * @returns {Array<{text: string, type: string}>}
 */
function collectDecisions(steps) {
  const seen = new Set();
  /** @type {Array<{text: string, type: string}>} */
  const decisions = [];
  for (const step of steps) {
    const output = asRecord(step.output);
    const raw = Array.isArray(output.decisions) ? output.decisions : [];
    for (const item of raw) {
      const record = typeof item === 'string' ? { text: item } : asRecord(item);
      const text = clip(String(record.text ?? ''), 500);
      if (text.length === 0 || seen.has(text)) {
        continue;
      }
      const type = MEMORY_TYPES.includes(record.type) ? record.type : 'decision';
      seen.add(text);
      decisions.push({ text, type });
    }
  }
  return decisions;
}

/**
 * Lessons the model proposed. A missing or unknown type is dropped, not
 * coerced: model text must not become a stored decision by default.
 *
 * @param {unknown} raw
 * @param {string} defaultType
 * @returns {Array<{text: string, type: string}>}
 */
function modelMemory(raw, defaultType) {
  if (!Array.isArray(raw)) {
    return [];
  }
  /** @type {Array<{text: string, type: string}>} */
  const items = [];
  for (const entry of raw) {
    const record = typeof entry === 'string' ? { text: entry, type: defaultType } : asRecord(entry);
    const text = clip(typeof record.text === 'string' ? record.text : '', 500);
    const type = typeof entry === 'string'
      ? defaultType
      : MEMORY_TYPES.includes(record.type)
        ? record.type
        : '';
    if (!text || !type) {
      continue;
    }
    items.push({ text, type });
    if (items.length >= 8) {
      break;
    }
  }
  return items;
}

/**
 * @param {Array<{text: string, type: string}>} existing
 * @param {Array<{text: string, type: string}>} extra
 * @returns {Array<{text: string, type: string}>}
 */
function mergeMemory(existing, extra) {
  const seen = new Set(existing.map((item) => item.text));
  const merged = [...existing];
  for (const item of extra) {
    if (seen.has(item.text)) {
      continue;
    }
    seen.add(item.text);
    merged.push(item);
    if (merged.length >= 16) {
      break;
    }
  }
  return merged;
}

/**
 * @param {Record<string, any>} output
 * @returns {object}
 */
function renderSummaryAdf(output) {
  /** @type {object[]} */
  const blocks = [
    heading(2, 'Run summary'),
    paragraph([textNode(output.summary)]),
  ];
  const decisions = output.decisions.filter((item) => item.type === 'decision');
  const lessons = output.decisions.filter((item) => item.type === 'lesson' || item.type === 'fact');
  if (decisions.length > 0) {
    blocks.push(heading(3, 'Decisions'));
    blocks.push(bulletList(decisions.map((item) => [textNode(item.text)])));
  }
  if (lessons.length > 0) {
    blocks.push(heading(3, 'Lessons'));
    blocks.push(bulletList(lessons.map((item) => [
      textNode(item.type === 'fact' ? `[fact] ${item.text}` : item.text),
    ])));
  }
  blocks.push(paragraph([textNode(sourceLine(output))]));
  return doc(blocks);
}

/**
 * @param {import('../store/types.js').Step} step
 * @param {any} ctx
 * @returns {Promise<{output: object, effects: Array<object>}>}
 */
export async function composeSummary(step, ctx) {
  const steps = await ctx.store.listSteps(ctx.run.runId);
  const killCheckpoint = beginFaultCheckpoint(ctx, 'after-evidence');
  if (killCheckpoint) await killCheckpoint;
  const completed = steps.filter(
    (candidate) => candidate.status === 'done' && candidate.stepId !== step.stepId,
  );
  const collected = collectDecisions(completed);
  const lead = completed.length === 0
    ? `Run "${ctx.run.goal}" finished with no completed steps.`
    : `Run "${ctx.run.goal}" completed ${completed.length} step(s).`;
  const fallbackSummary = completed.length === 0
    ? lead
    : [lead, ...completed.map(summarizeStepOutput)].join('\n');

  /** @type {Record<string, any>} */
  let output = {
    workerType: 'summarize',
    summary: fallbackSummary,
    decisions: collected,
    lessons: collected.filter((item) => item.type === 'lesson'),
    stepCount: completed.length,
    completedAt: typeof ctx.now === 'function' ? ctx.now() : Date.now(),
    generator: 'fallback',
    model: null,
  };

  const llm = await completeText(
    {
      system: SYSTEM_PROMPT,
      user: summarizeUserPrompt(step, ctx.run, completed),
      maxTokens: 1000,
      // Run budget meter. Not `brief.budget`, which caps tool calls.
      meter: ctx.modelMeter,
    },
    ctx.llm,
  );
  noteFallback(ctx, 'summarize', llm);
  if (llm.ok) {
    const data = parseModelJson(llm.text);
    const modelSummary = data ? clip(data.summary, 1500) : '';
    if (data && modelSummary) {
      const extra = [
        ...modelMemory(data.lessons, 'lesson'),
        ...modelMemory(data.decisions, 'decision'),
      ];
      const decisions = mergeMemory(collected, extra);
      output = {
        ...output,
        // The lead line keeps "completed N step(s)" in run.summary. The
        // model text follows it. Step bullets stay so the Epic comment still
        // names the work.
        summary: [lead, '', modelSummary, '', ...completed.map(summarizeStepOutput)].join('\n'),
        decisions,
        lessons: decisions.filter((item) => item.type === 'lesson'),
        generator: 'llm',
        model: llm.model ?? null,
        usage: llm.usage ?? null,
      };
    }
  }

  const bodyText = `${output.summary}\n\n${sourceLine(output)}`;
  return {
    output,
    // No deferred comment. The automatic summarize step is not given a child
    // issue. WP6 posts the Epic "[Conductor memory]" comment from this output.
    // A planned summarize step that already has a child key gets the ADF too.
    effects: commentEffect(
      step,
      bodyText,
      renderSummaryAdf(output),
      'summarize-comment',
      { defer: false },
    ),
  };
}
