/**
 * On-demand skill library (WP15).
 *
 * Skills are Markdown packs in `skills/*.md`. Adding a file is the whole
 * install: this module discovers packs by reading the directory. There is no
 * registry to edit, which is the demo ("drop in risk-review.md, no code
 * change").
 *
 * Progressive loading, same idea as DeerFlow's skill index:
 * - `listSkillIndex` returns `{name, description}` only. The Router prompt
 *   and `recall-memory` use this. The Markdown body is parsed and then
 *   discarded, so it is not sitting in the object the Router sees.
 * - `loadSkill` reads the file again and returns the body, tools, output
 *   schema, done-when line, and budget. The step worker calls this when that
 *   step actually runs.
 *
 * The directory is scanned on every call. A long-lived cache would hide a
 * skill file added while the process is still up (tests, and a tunnel).
 * Forge invocations are already short, so the extra reads are a few small
 * files.
 *
 * Where the files live: `CONDUCTOR_SKILLS_DIR` if set, otherwise `<repo>/skills`
 * next to this module (`src/skills` → `../../skills`). Tests can point the
 * loader at a temp directory with `setSkillRoot` and must reset it.
 *
 * Forge's default bundler only uploads files the bundle imports. This loader
 * uses `node:fs`, which works in `node --test` and in any packaging mode that
 * leaves `skills/` on disk. If the directory is missing at runtime, the index
 * is empty and the built-in workers still run. That is the deterministic
 * fallback; it is not a second copy of the packs hidden in JavaScript.
 *
 * @module skills/library
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SkillContractError, SkillLibraryError } from './errors.js';
import { splitFrontmatter } from './frontmatter.js';
import { EMBEDDED_SKILL_FILES } from './packs.generated.js';

/** Skill names match worker type names: lowercase, digits, single hyphens. */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** @type {string|null} */
let rootOverride = null;

/**
 * Repo `skills/` directory, derived from this file's URL so the loader does
 * not depend on `process.cwd()` (Forge does not promise a particular cwd).
 *
 * @returns {string}
 */
export function defaultSkillRoot() {
  if (process.env.CONDUCTOR_SKILLS_DIR) {
    return process.env.CONDUCTOR_SKILLS_DIR;
  }
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
}

/**
 * Directory scanned by the loader.
 *
 * @returns {string}
 */
export function skillRoot() {
  return rootOverride || defaultSkillRoot();
}

/**
 * Point the loader at another directory. Pass `null` to use the default.
 * Tests use this. Production code should not.
 *
 * @param {string|null} root
 * @returns {void}
 */
export function setSkillRoot(root) {
  rootOverride = root;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function stringList(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string' && value.length > 0) return [value];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new SkillLibraryError('tools must be a list of strings');
  }
  return value;
}

/**
 * @param {Record<string, any>} data
 * @param {string} file
 * @returns {{maxToolCalls: number, maxOutputBytes: number, maxRepairAttempts: number}}
 */
function readBudget(data, file) {
  const budget = data.budget && typeof data.budget === 'object' ? data.budget : {};
  const maxToolCalls = budget.maxToolCalls === undefined ? 4 : budget.maxToolCalls;
  const maxOutputBytes = budget.maxOutputBytes === undefined ? 2048 : budget.maxOutputBytes;
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 0) {
    throw new SkillLibraryError(`${file}: budget.maxToolCalls must be an integer >= 0`, { file });
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new SkillLibraryError(`${file}: budget.maxOutputBytes must be an integer >= 1`, { file });
  }
  return {
    maxToolCalls,
    maxOutputBytes,
    // The harness repairs once, whatever the file asks for. The field is
    // stored so the brief the panel shows matches the real behaviour.
    maxRepairAttempts: 1,
  };
}

/**
 * @param {Record<string, any>} data
 * @param {string} file
 * @returns {Record<string, any>}
 */
function readOutputSchema(data, file) {
  if (data.outputSchema === undefined) {
    return {
      type: 'object',
      required: ['summary'],
      properties: {
        summary: { type: 'string', maxLength: 2000 },
      },
    };
  }
  if (!data.outputSchema || typeof data.outputSchema !== 'object' || Array.isArray(data.outputSchema)) {
    throw new SkillLibraryError(`${file}: outputSchema must be a JSON object`, { file });
  }
  return data.outputSchema;
}

/**
 * Turn one Markdown file into a pack. `body` is included; the index helper
 * drops it before returning.
 *
 * @param {string} fileName
 * @param {string} text
 * @returns {import('./types.js').SkillPack}
 */
export function parseSkillFile(fileName, text) {
  const { data, body } = splitFrontmatter(text, fileName);
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!SKILL_NAME.test(name)) {
    throw new SkillLibraryError(
      `${fileName}: name must be lowercase letters, digits, and hyphens`,
      { file: fileName },
    );
  }
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (!description) {
    throw new SkillLibraryError(`${fileName}: description is required`, { file: fileName });
  }
  const procedure = typeof data.procedure === 'string' && data.procedure.trim()
    ? data.procedure.trim()
    : 'checklist';
  if (procedure !== 'builtin' && procedure !== 'checklist') {
    throw new SkillLibraryError(
      `${fileName}: procedure must be "builtin" or "checklist"`,
      { file: fileName },
    );
  }
  const doneWhen = typeof data.doneWhen === 'string' && data.doneWhen.trim()
    ? data.doneWhen.trim()
    : 'The short result answers the objective.';
  return {
    name,
    description,
    tools: stringList(data.tools),
    procedure,
    doneWhen,
    budget: readBudget(data, fileName),
    outputSchema: readOutputSchema(data, fileName),
    body,
    fileName,
  };
}

/**
 * Read every `*.md` pack in the skill root.
 *
 * @param {string} [root]
 * @returns {import('./types.js').SkillPack[]}
 */
export function loadAllSkills(root = skillRoot()) {
  // The Forge bundle does not ship skills/. Fall back to the packs embedded at
  // build time when the default root is missing (an explicit root stays strict).
  const embedded = !existsSync(root) && root === defaultSkillRoot();
  if (!existsSync(root) && !embedded) {
    return [];
  }
  const fileNames = (embedded ? Object.keys(EMBEDDED_SKILL_FILES) : readdirSync(root))
    .filter((name) => name.endsWith('.md') && !name.startsWith('.') && !name.startsWith('_'))
    .sort();
  /** @type {Map<string, import('./types.js').SkillPack>} */
  const byName = new Map();
  for (const fileName of fileNames) {
    const text = embedded ? EMBEDDED_SKILL_FILES[fileName] : readFileSync(join(root, fileName), 'utf8');
    const pack = parseSkillFile(fileName, text);
    if (byName.has(pack.name)) {
      throw new SkillLibraryError(
        `Two skill files use the name "${pack.name}" (${byName.get(pack.name).fileName} and ${fileName})`,
        { file: fileName },
      );
    }
    byName.set(pack.name, pack);
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Names and descriptions only. The body, tools, and schema are not returned.
 * This is what the Router is allowed to see.
 *
 * @param {string} [root]
 * @returns {Array<{name: string, description: string}>}
 */
export function listSkillIndex(root = skillRoot()) {
  return loadAllSkills(root).map((pack) => ({
    name: pack.name,
    description: pack.description,
  }));
}

/**
 * @param {string} [root]
 * @returns {string[]}
 */
export function listSkillNames(root = skillRoot()) {
  return listSkillIndex(root).map((entry) => entry.name);
}

/**
 * Load one pack, including the Markdown body. Call this when a step runs,
 * not when the Router is choosing a name.
 *
 * @param {string} name
 * @param {string} [root]
 * @returns {import('./types.js').SkillPack}
 */
export function loadSkill(name, root = skillRoot()) {
  if (typeof name !== 'string' || !SKILL_NAME.test(name)) {
    throw new SkillContractError(`Unknown skill "${name}"`, { code: 'UNKNOWN_SKILL' });
  }
  const pack = loadAllSkills(root).find((candidate) => candidate.name === name);
  if (!pack) {
    throw new SkillContractError(`Unknown skill "${name}"`, { code: 'UNKNOWN_SKILL' });
  }
  return pack;
}

/**
 * `null` when the name is not a pack. Used so a test-only worker type can
 * run without a Markdown file.
 *
 * @param {string} name
 * @param {string} [root]
 * @returns {import('./types.js').SkillPack|null}
 */
export function tryLoadSkill(name, root = skillRoot()) {
  try {
    return loadSkill(name, root);
  } catch (error) {
    if (error instanceof SkillContractError && error.code === 'UNKNOWN_SKILL') {
      return null;
    }
    throw error;
  }
}
