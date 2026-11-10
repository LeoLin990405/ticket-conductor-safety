/**
 * Scrubbable timeline derived from the append-only event log.
 *
 * Pure data in, plain objects out. The UI Kit panel renders the result and
 * does not import Node or the store. Durations are the gap since the
 * previous event. Retry, self-heal, and replan rows carry markers the panel
 * shows as lozenges.
 *
 * @module recorder/timeline
 */

/** Human labels for event kinds. @type {Record<string, string>} */
export const EVENT_LABELS = Object.freeze({
  'plan.created': 'Plan created',
  'step.queued': 'Step queued',
  'step.started': 'Step started',
  'step.succeeded': 'Step succeeded',
  'step.failed': 'Step failed',
  'step.retried': 'Retry',
  'watchdog.self-heal': 'Self-heal',
  'effect.written': 'Effect written',
  'memory.written': 'Memory written',
  replan: 'Re-plan',
  'run.forked': 'Fork',
  wave_started: 'Wave started',
  lead_decision: 'Lead decision',
  digest_written: 'Digest written',
});

/**
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '0 ms';
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

/**
 * @param {string} kind
 * @returns {string[]}
 */
export function markersFor(kind) {
  if (kind === 'step.retried') {
    return ['retry'];
  }
  if (kind === 'watchdog.self-heal') {
    return ['self-heal'];
  }
  if (kind === 'replan') {
    return ['replan'];
  }
  if (kind === 'wave_started') {
    return ['wave'];
  }
  if (kind === 'lead_decision') {
    return ['lead'];
  }
  if (kind === 'digest_written') {
    return ['digest'];
  }
  return [];
}

/**
 * @param {Array<import('../store/types.js').FlightEvent>} events
 * @returns {Array<object>}
 */
export function buildTimeline(events) {
  const sorted = [...(events ?? [])].sort((left, right) => {
    const seq = (left.seq ?? 0) - (right.seq ?? 0);
    if (seq !== 0) {
      return seq;
    }
    return String(left.eventId).localeCompare(String(right.eventId));
  });
  let previousAt = null;
  return sorted.map((event, index) => {
    const at = Number(event.at) || 0;
    const durationMs = previousAt === null ? 0 : Math.max(0, at - previousAt);
    previousAt = at;
    const detail = event.detail && typeof event.detail === 'object'
      ? event.detail
      : {};
    const markers = markersFor(event.kind);
    return {
      index,
      eventId: event.eventId,
      seq: event.seq,
      kind: event.kind,
      label: EVENT_LABELS[event.kind] ?? event.kind,
      at,
      durationMs,
      durationLabel: formatDuration(durationMs),
      stepIdx: event.stepIdx,
      stepId: event.stepId,
      journalKey: event.journalKey,
      markers,
      retry: markers.includes('retry'),
      selfHeal: markers.includes('self-heal'),
      replan: markers.includes('replan'),
      wave: markers.includes('wave'),
      lead: markers.includes('lead'),
      digest: markers.includes('digest'),
      detail,
      title: typeof detail.title === 'string' ? detail.title : '',
    };
  });
}

/**
 * Events visible when the scrubber sits on `cursor` (inclusive).
 *
 * @param {Array<object>} timeline
 * @param {number} cursor
 * @returns {Array<object>}
 */
export function scrubTo(timeline, cursor) {
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return [];
  }
  const max = timeline.length - 1;
  const index = Math.max(0, Math.min(max, Math.trunc(Number(cursor) || 0)));
  return timeline.slice(0, index + 1);
}
