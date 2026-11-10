/**
 * Tiny frontmatter reader for skill packs (WP15).
 *
 * Skill files are Markdown with a YAML-shaped header between `---` lines.
 * Forge functions should not take a YAML dependency for a format this small,
 * so this parser accepts only the subset the packs use:
 *
 * - `key: value` scalars (strings, integers, booleans)
 * - quoted strings, so a description may contain a colon
 * - one-line JSON when the value starts with `{` or `[`
 * - nested maps indented by spaces (`budget:` then `  maxToolCalls:`)
 * - lists written as `  - item` under a key
 *
 * Anything richer belongs in the Markdown body, which the parser does not
 * interpret. The body is returned whole so the worker can load it later.
 *
 * @module skills/frontmatter
 */

import { SkillLibraryError } from './errors.js';

/**
 * @param {string} text
 * @returns {string}
 */
function stripQuotes(text) {
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * @param {string} text
 * @param {string} file
 * @returns {string|number|boolean|null|object|Array<unknown>}
 */
function parseScalar(text, file) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new SkillLibraryError(
        `${file}: could not parse JSON value (${error instanceof Error ? error.message : String(error)})`,
        { file },
      );
    }
  }
  return stripQuotes(text);
}

/**
 * Parse the header block. `file` is only used in error messages.
 *
 * @param {string} yaml
 * @param {string} file
 * @returns {Record<string, any>}
 */
export function parseSimpleYaml(yaml, file = 'skill') {
  const lines = yaml.split('\n');
  /** @type {Record<string, any>} */
  const root = {};
  /** @type {Array<{indent: number, value: any}>} */
  const stack = [{ indent: -1, value: root }];

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim() || raw.trim().startsWith('#')) {
      continue;
    }
    const indent = raw.match(/^ */)[0].length;
    const line = raw.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].value;

    if (line.startsWith('- ')) {
      if (!Array.isArray(parent)) {
        throw new SkillLibraryError(
          `${file}: list item is not under a list (${line})`,
          { file },
        );
      }
      parent.push(parseScalar(line.slice(2).trim(), file));
      continue;
    }

    const colon = line.indexOf(':');
    if (colon <= 0) {
      throw new SkillLibraryError(`${file}: expected key: value (${line})`, { file });
    }
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (Array.isArray(parent)) {
      throw new SkillLibraryError(
        `${file}: a list cannot contain "${key}:"`,
        { file },
      );
    }

    if (rest !== '') {
      parent[key] = parseScalar(rest, file);
      continue;
    }

    const next = lines.slice(index + 1).find((candidate) => candidate.trim());
    const nextTrim = next ? next.trim() : '';
    const child = nextTrim.startsWith('- ') ? [] : {};
    parent[key] = child;
    stack.push({ indent, value: child });
  }

  return root;
}

/**
 * Split a skill file into header data and the Markdown body.
 *
 * The body is not parsed. Callers that only need the index should discard it.
 *
 * @param {string} text
 * @param {string} [file]
 * @returns {{ data: Record<string, any>, body: string }}
 */
export function splitFrontmatter(text, file = 'skill') {
  const normalized = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new SkillLibraryError(
      `${file}: a skill file must start with a --- frontmatter block`,
      { file },
    );
  }
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) {
    throw new SkillLibraryError(
      `${file}: the frontmatter block is not closed with ---`,
      { file },
    );
  }
  const yaml = normalized.slice(4, end);
  const body = normalized.slice(end + '\n---\n'.length);
  return { data: parseSimpleYaml(yaml, file), body };
}
