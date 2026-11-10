/**
 * Best-effort writer for the flight recorder.
 *
 * Recording must not block a Jira effect, a step, or the watchdog. If the
 * installed store has no `appendEvent` (a unit test passed a partial fake)
 * or the write fails, the caller still finishes its real work. The event
 * is the audit log; the effect row remains the source of truth for whether
 * Jira was touched.
 *
 * @module recorder/log
 */

import { buildGenAiSpan } from './otel.js';

/**
 * @param {{appendEvent?: Function}|null|undefined} store
 * @param {import('../store/types.js').EventInput} input
 * @returns {Promise<import('../store/types.js').FlightEvent|null>}
 */
export async function recordEvent(store, input) {
  if (!store || typeof store.appendEvent !== 'function') {
    return null;
  }
  if (!input || typeof input !== 'object') {
    return null;
  }
  const span = input.span ?? buildGenAiSpan(input);
  try {
    return await store.appendEvent({ ...input, span });
  } catch {
    // The run must keep going. A missing event is visible as a gap in the
    // timeline; it is not a reason to write Jira twice or to fail the step.
    return null;
  }
}
