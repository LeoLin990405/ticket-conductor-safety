/**
 * Server-side guard for irreversible Jira writes.
 *
 * The Rovo confirmation card is not the gate. `dispatch-run` and `fork-run`
 * refuse to enqueue anything until the caller repeats the blast-radius
 * acknowledgement and the confirmation token this module derives from the
 * card. A string `"true"`, a bare `confirm: true`, or a token for a different
 * card leaves the run in `planning`.
 *
 * The token is a hash of the run, the Epic, the score line, and the request
 * keys of the mutating writes (child issues, transitions, field edits).
 * Comment keys are left out so a citation comment cannot change the token
 * between `plan-split` and dispatch. The hash is not a secret: the model
 * sees it in the tool result. The handler still rejects a call that omits
 * it, and the router prompt forbids the model from copying it until a later
 * user message agrees to the plan that was shown.
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
 * Token for one blast-radius card. Same card, same token. A different
 * score, a different Epic, or a different set of mutating request keys
 * produces a different token.
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
 * Decide whether this payload may start the run described by `card`.
 *
 * `confirm` must be the boolean `true`. The string `"true"` is refused.
 * `acknowledgeBlastRadius` must equal {@link acknowledgementText}.
 * `confirmToken` must equal {@link confirmationToken}.
 *
 * @param {object|null|undefined} payload
 * @param {object|null|undefined} card
 * @returns {{ok: true, code: 'CONFIRMED', token: string, acknowledgement: string}|{ok: false, code: string, reason: string}}
 */
export function evaluateDispatchAuthorization(payload, card) {
  const acknowledgement = acknowledgementText(card);
  const token = confirmationToken(card);
  if (!payload || payload.confirm !== true) {
    return {
      ok: false,
      code: CONFIRMATION_REQUIRED,
      reason: 'confirm must be the boolean true',
    };
  }
  if (payload.acknowledgeBlastRadius !== acknowledgement) {
    return {
      ok: false,
      code: CONFIRMATION_REQUIRED,
      reason: 'acknowledgeBlastRadius must match the blast-radius card',
    };
  }
  if (typeof payload.confirmToken !== 'string' || payload.confirmToken !== token) {
    return {
      ok: false,
      code: CONFIRMATION_REQUIRED,
      reason: 'confirmToken does not match this blast radius',
    };
  }
  return { ok: true, code: 'CONFIRMED', token, acknowledgement };
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
 * @param {object|null|undefined} payload
 * @returns {{ok: true, code: 'CONFIRMED'}|{ok: false, code: string, reason: string}}
 */
export function evaluateForkAuthorization(payload) {
  const runId = typeof payload?.runId === 'string' ? payload.runId.trim() : '';
  const stepIdx = payload?.stepIdx;
  const acknowledgement = forkAcknowledgement(runId, stepIdx);
  const token = forkConfirmationToken(runId, stepIdx, payload?.input);
  if (!payload || payload.confirm !== true) {
    return {
      ok: false,
      code: CONFIRMATION_REQUIRED,
      reason: 'confirm must be the boolean true',
    };
  }
  if (payload.acknowledgeBlastRadius !== acknowledgement) {
    return {
      ok: false,
      code: CONFIRMATION_REQUIRED,
      reason: 'acknowledgeBlastRadius must match the fork card',
    };
  }
  if (typeof payload.confirmToken !== 'string' || payload.confirmToken !== token) {
    return {
      ok: false,
      code: CONFIRMATION_REQUIRED,
      reason: 'confirmToken does not match this fork',
    };
  }
  return { ok: true, code: 'CONFIRMED' };
}

/**
 * Fields a caller copies from a `plan-split` result onto `dispatch-run`.
 *
 * @param {object|null|undefined} card
 * @returns {{acknowledgement: string, confirmToken: string}}
 */
export function confirmationFields(card) {
  return {
    acknowledgement: acknowledgementText(card),
    confirmToken: confirmationToken(card),
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
