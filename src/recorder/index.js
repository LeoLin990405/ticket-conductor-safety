/**
 * Flight recorder: append-only event log, journal lookup, replay, and fork.
 *
 * Replay answers "what would this run do against today's Jira?" and writes
 * nothing. Fork copies the log up to a step onto a new run and re-runs only
 * the downstream steps. Both look up step results and effects by requestKey
 * so an already-applied Jira write is not repeated.
 *
 * The ideas are borrowed, not the runtimes. LangGraph checkpoints and time
 * travel, Temporal's event history, and DBOS durable steps keyed for
 * idempotency do not run inside Forge. See docs/flight-recorder.md.
 *
 * @module recorder
 */

export { selectForkSets, downstreamIdxs, dependsOnOf } from './graph.js';
export { forkRun, parseForkInput } from './fork.js';
export { lookupAppliedEffect, lookupJournal, stepResultKey } from './journal.js';
export { recordEvent } from './log.js';
export { DETERMINISTIC_MODEL, buildGenAiSpan, toOtlpJson } from './otel.js';
export { replayRun } from './replay.js';
export { STALL_REPLAN_THRESHOLD, buildPartialReplan } from './replan.js';
export { compactDetail, stableStringify } from './stable.js';
export {
  EVENT_LABELS,
  buildTimeline,
  formatDuration,
  markersFor,
  scrubTo,
} from './timeline.js';
