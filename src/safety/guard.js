/**
 * Blast-radius lines that a confirmation grant is bound to.
 *
 * The strings in this file are not secrets. `plan-split` returns
 * `acknowledgement` and the card. It does not return a token. The HMAC
 * grant, the expiry, and the single-use row live in `safety/grants.js`.
 * A caller who hashes this card still cannot mint a token: the grant id
 * and the server secret are not on the card.
 *
 * @module safety/guard
 */

import { createHash } from 'node:crypto';

/** Refusal code for a missing or mismatched confirmation. @constant {string} */
export const CONFIRMATION_REQUIRED = 'CONFIRMATION_REQUIRED';

/** Refusal code when a confirmed run is already outside its budget. @constant {string} */
export const BUDGET_EXCEEDED = 'BUDGET_EXCEEDED';

/**
 * Kinds whose request keys are bound into the dispatch token.
 * Comments are not irreversible in the same way and are omitted.
 *
 * @constant {ReadonlySet<string>}
 */
const MUTATING_KINDS = new Set(['createIssue', 'transition', 'setFields']);

/**
 * One line the caller must echo. It is the blast-radius score and the
 * counts of issues, transitions, and field edits. Comments are not in it.
 *
 * @param {object|null|undefined} card `previewBlastRadius` result.
 * @returns {string}
 */
export function acknowledgementText(card) {
  const score = integerOrZero(card?.risk?.score);
  const issues = integerOrZero(card?.counts?.issues);
  const transitions = integerOrZero(card?.counts?.transitions);
  const fieldChanges = integerOrZero(card?.counts?.fieldChanges);
  return `${score} points, ${issues} issues, ${transitions} transitions, ${fieldChanges} field changes`;
}

/**
 * Public digest of one blast-radius card. Same card, same digest. This is
 * an input to the HMAC grant. It is not a `confirmToken`, and presenting
 * it to `dispatch-run` is refused.
 *
 * @param {object|null|undefined} card
 * @returns {string} 64 hex characters.
 */
export function confirmationToken(card) {
  const keys = mutatingRequestKeys(card);
  const lines = [
    'tc-irreversible-v1',
    typeof card?.runId === 'string' ? card.runId : '',
    typeof card?.epicKey === 'string' ? card.epicKey : '',
    acknowledgementText(card),
    ...keys,
  ];
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * Sentence the caller echoes to fork a run. The step index is part of it
 * so a fork from a different step is a different acknowledgement.
 *
 * @param {string} runId
 * @param {unknown} stepIdx
 * @returns {string}
 */
export function forkAcknowledgement(runId, stepIdx) {
  return `fork ${String(runId ?? '')} from step ${String(stepIdx)}`;
}

/**
 * @param {string} runId
 * @param {unknown} stepIdx
 * @param {unknown} [input] Replacement step input, when the fork edits one.
 * @returns {string}
 */
export function forkConfirmationToken(runId, stepIdx, input) {
  const edited = input === undefined || input === null ? '' : String(input);
  return createHash('sha256').update(
    ['tc-fork-v1', String(runId ?? ''), String(stepIdx), edited].join('\n'),
  ).digest('hex');
}

/**
 * What an agent-facing result may carry. The acknowledgement is the line
 * the person reads. The token is not here.
 *
 * @param {object|null|undefined} card
 * @returns {{acknowledgement: string}}
 */
export function confirmationFields(card) {
  return {
    acknowledgement: acknowledgementText(card),
  };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function integerOrZero(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * @param {object|null|undefined} card
 * @returns {string[]}
 */
function mutatingRequestKeys(card) {
  const writes = Array.isArray(card?.writes) ? card.writes : [];
  const keys = [];
  for (const write of writes) {
    if (!write || !MUTATING_KINDS.has(write.kind)) continue;
    if (typeof write.requestKey !== 'string' || write.requestKey.length === 0) continue;
    keys.push(write.requestKey);
  }
  keys.sort();
  return keys;
}
