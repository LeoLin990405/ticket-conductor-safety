/**
 * Deterministic procedures for skill packs that have no JavaScript worker
 * (WP15).
 *
 * `checklist` reads a `## Checklist` section from the skill body and turns
 * each bullet into a note on the step. That is the whole extension point:
 * a new `skills/security-notes.md` with a checklist runs without a code
 * change. The notes are templated. They are not a model judgement.
 *
 * `builtin` is handled by the harness, which calls the registered worker
 * (`research`, `draft-spec`, `check-deps`, `summarize`). This module does
 * not import those workers, so the skill library stays free of the worker
 * registry.
 *
 * If WP11 later registers a model runner, the harness may ask it to fill
 * the same output shape. A null result falls back to this procedure.
 *
 * @module skills/procedures
 */

/**
 * Bullets under the first `## Checklist` heading.
 *
 * @param {string} body
 * @returns {string[]}
 */
export function checklistItems(body) {
  const lines = String(body || '').split('\n');
  let inList = false;
  /** @type {string[]} */
  const items = [];
  for (const line of lines) {
    if (/^##\s+Checklist\b/i.test(line.trim())) {
      inList = true;
      continue;
    }
    if (inList && /^##\s+/.test(line.trim())) {
      break;
    }
    if (!inList) continue;
    const match = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (match) items.push(match[1]);
  }
  return items;
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function shorten(text, max) {
  const single = String(text || '').replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

/**
 * @param {object} args
 * @param {import('./types.js').SkillPack} args.skill
 * @param {import('./types.js').SubAgentBrief} args.brief
 * @param {Record<string, any>} args.step
 * @param {Record<string, any>|null|undefined} [args.run]
 * @returns {Record<string, any>}
 */
export function runChecklist({ skill, brief, step, run }) {
  const items = checklistItems(skill.body);
  const subject = shorten(
    `${brief.objective} ${run?.goal || ''} ${step?.title || ''}`,
    120,
  );
  const notes = items.map((item) => `${item} — checked against "${subject}"`);
  const summary = notes.length === 0
    ? `${skill.name}: no checklist items in the skill file.`
    : `${skill.name}: ${notes.length} check(s). ${shorten(notes[0], 240)}`;
  return {
    summary,
    result: summary,
    notes,
    confidence: notes.length > 0 ? 0.6 : 0.3,
  };
}
