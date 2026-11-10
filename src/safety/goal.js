/**
 * Refuse a goal that does not name a concrete change.
 *
 * `plan-split` stores a run before any Jira write. An empty, vague, or
 * oversized goal stops there. The caller has to say what should change.
 * A short concrete goal such as "Ship refunds" is accepted. "do it",
 * "fix this", and a string of punctuation are not.
 *
 * @module safety/goal
 */

/** Goals longer than this are refused before a run is stored. @constant {number} */
export const MAX_GOAL_CHARS = 2_000;

const VAGUE = new Set([
  'do it',
  'do this',
  'fix',
  'fix it',
  'fix this',
  'help',
  'help me',
  'handle it',
  'handle this',
  'ship it',
  'ship this',
  'update',
  'update it',
  'change it',
  'make it better',
  'as discussed',
  'you decide',
  'whatever',
  'something',
  'the ticket',
  'this ticket',
  'todo',
  'tbd',
  'continue',
  'proceed',
  'go ahead',
  'ok',
  'okay',
  'yes',
  'first',
  'not sure',
  'idk',
]);

const STOP = new Set([
  'a', 'an', 'the', 'to', 'of', 'and', 'or', 'for', 'on', 'in', 'it',
  'this', 'that', 'please', 'just',
]);

/**
 * @param {unknown} goal
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function assessGoal(goal) {
  if (typeof goal !== 'string') {
    return { ok: false, reason: 'goal must be text' };
  }
  if (goal.includes('\0')) {
    return { ok: false, reason: 'goal contains a null character' };
  }
  const trimmed = goal.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'goal is missing' };
  }
  if (trimmed.length > MAX_GOAL_CHARS) {
    return { ok: false, reason: 'goal is too long to act on' };
  }
  const normalized = trimmed
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[a-z0-9]/i.test(normalized) || VAGUE.has(normalized)) {
    return { ok: false, reason: 'goal does not name a concrete change' };
  }
  const tokens = normalized.split(' ').filter((token) => token.length > 0 && !STOP.has(token));
  if (tokens.length === 0) {
    return { ok: false, reason: 'goal is missing a concrete change' };
  }
  if (tokens.length === 1 && tokens[0].length < 8) {
    return { ok: false, reason: 'goal does not name a concrete change' };
  }
  return { ok: true };
}
