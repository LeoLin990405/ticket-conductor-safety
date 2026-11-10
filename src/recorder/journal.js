/**
 * Step journal keys (DBOS / Temporal / Inngest idea, Forge storage).
 *
 * A durable workflow checkpoints each step's result under a stable key and,
 * on replay, returns that checkpoint instead of repeating the side effect.
 * Ticket Conductor already does this for Jira mutations: `requestKeyFor` is
 * sha256(runId|stepId|kind|discriminator), and the effect applier skips a row
 * whose status is `applied`.
 *
 * A step result is not itself a Jira mutation, so it cannot use `requestKeyFor`
 * (that helper rejects any kind other than createIssue, comment, or
 * transition). `stepResultKey` is the same pipe-hash, with the fixed segment
 * `step-result`. Replay and fork look the key up on the event journal. A hit
 * means "this already happened; do not write it to Jira again".
 *
 * The attempt is part of the step-result key so a watchdog retry can record
 * a new checkpoint without pretending it is the same execution. Effect
 * request keys stay attempt-independent, which is what keeps Jira writes
 * deduped across those retries.
 *
 * @module recorder/journal
 */

import { createHash } from 'node:crypto';

/**
 * Checkpoint id for one execution of a step.
 *
 * @param {{runId: string, stepId: string, attempt?: number}} input
 * @returns {string} Lower-case sha256 hex digest.
 */
export function stepResultKey(input) {
  const runId = String(input?.runId ?? '');
  const stepId = String(input?.stepId ?? '');
  const attempt = Number.isInteger(input?.attempt) ? input.attempt : 0;
  return createHash('sha256')
    .update(`${runId}|${stepId}|step-result|${attempt}`, 'utf8')
    .digest('hex');
}

/**
 * Events whose `journalKey` is this request key or step-result key.
 * Oldest seq first. An empty list means nothing has been checkpointed.
 *
 * @param {{listEventsByJournalKey?: Function}} store
 * @param {string} journalKey
 * @returns {Promise<import('../store/types.js').FlightEvent[]>}
 */
export async function lookupJournal(store, journalKey) {
  if (!journalKey || typeof store?.listEventsByJournalKey !== 'function') {
    return [];
  }
  return store.listEventsByJournalKey(journalKey);
}

/**
 * Decide whether a Jira effect may be written.
 *
 * A stored effect with status `applied`, or a journal event that already
 * recorded `phase: 'applied'`, is a hit. Callers must skip the write and
 * report the previous result. This is the "zero duplicate writes" rule.
 *
 * @param {{getEffect?: Function, listEventsByJournalKey?: Function}} store
 * @param {string} requestKey
 * @returns {Promise<{requestKey: string, effect: import('../store/types.js').Effect|null, events: import('../store/types.js').FlightEvent[], skipWrite: boolean, verdict: 'already-applied-skipped'|'would-apply'}>}
 */
export async function lookupAppliedEffect(store, requestKey) {
  const effect = typeof store?.getEffect === 'function'
    ? await store.getEffect(requestKey)
    : null;
  const events = await lookupJournal(store, requestKey);
  const journalApplied = events.some((event) => event?.detail?.phase === 'applied');
  const skipWrite = effect?.status === 'applied' || journalApplied;
  return {
    requestKey,
    effect: effect ?? null,
    events,
    skipWrite,
    verdict: skipWrite ? 'already-applied-skipped' : 'would-apply',
  };
}
