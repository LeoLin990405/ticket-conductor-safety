/**
 * JSDoc types for the skill library (WP15).
 *
 * A pack is the parsed Markdown file. A brief is the per-step contract the
 * worker actually runs under. The brief is what gets stored on the step.
 *
 * @module skills/types
 */

/**
 * One skill file after parsing.
 *
 * @typedef {object} SkillPack
 * @property {string} name
 * @property {string} description One line. This is the only prose the Router sees.
 * @property {string[]} tools Tool names the worker may call. Empty means none.
 * @property {'builtin'|'checklist'} procedure
 *   `builtin` calls the registered worker. `checklist` is the data-only
 *   procedure, so a new file needs no JavaScript.
 * @property {string} doneWhen Termination condition, copied onto the brief.
 * @property {{maxToolCalls: number, maxOutputBytes: number, maxRepairAttempts: number}} budget
 * @property {Record<string, any>} outputSchema Subset of JSON Schema.
 * @property {string} body Markdown after the frontmatter. Not part of the index.
 * @property {string} fileName
 */

/**
 * Structured brief stored on `step.brief`.
 *
 * @typedef {object} SubAgentBrief
 * @property {string} objective
 * @property {string[]} allowedTools
 * @property {string} doneWhen
 * @property {{maxToolCalls: number, maxOutputBytes: number, maxRepairAttempts: number}} budget
 */

/**
 * Short result stored on `step.output`. The long text goes to the child issue.
 *
 * @typedef {object} ShortResult
 * @property {string} skill
 * @property {string} result
 * @property {string} summary Same text as `result`, so the summarize worker still reads it.
 * @property {number} confidence
 * @property {string[]} artifacts Jira issue keys cited by the full output.
 * @property {boolean} repaired True when the one repair retry changed the output.
 * @property {Array<{text: string, type: string}>} [decisions]
 */

export {};
