/**
 * Display helpers for the Run panel. Kept free of UI Kit so tests can import
 * them without rendering.
 *
 * @module frontend/status
 */

/** @type {Record<string, 'default'|'inprogress'|'moved'|'new'|'removed'|'success'>} */
const APPEARANCE = {
  planning: 'default',
  queued: 'default',
  waiting: 'new',
  running: 'inprogress',
  'awaiting-review': 'moved',
  done: 'success',
  blocked: 'removed',
  failed: 'removed',
  pending: 'inprogress',
  applying: 'inprogress',
  applied: 'success',
  retrying: 'moved',
};

/**
 * @param {string|undefined} status
 * @returns {'default'|'inprogress'|'moved'|'new'|'removed'|'success'}
 */
export function lozengeAppearance(status) {
  return APPEARANCE[status] ?? 'default';
}

/**
 * One line for the chaos proof. The panel shows it only when a counter
 * has moved. Zeros stay on the data model (`loadRun` and `get-run-status`)
 * so a later copy pass can always render them.
 *
 * @param {{injected?: number, healed?: number, duplicateWrites?: number}|null|undefined} chaos
 * @returns {string}
 */
export function chaosSummary(chaos) {
  const injected = Number.isInteger(chaos?.injected) && chaos.injected >= 0 ? chaos.injected : 0;
  const healed = Number.isInteger(chaos?.healed) && chaos.healed >= 0 ? chaos.healed : 0;
  const duplicateWrites = Number.isInteger(chaos?.duplicateWrites) && chaos.duplicateWrites >= 0
    ? chaos.duplicateWrites
    : 0;
  return `${injected} injected, ${healed} healed, ${duplicateWrites} duplicate writes`;
}

/**
 * True when the panel should show the chaos line. A run that never fired
 * a fault stays visually the same.
 *
 * @param {{injected?: number, healed?: number, duplicateWrites?: number}|null|undefined} chaos
 * @returns {boolean}
 */
export function hasChaosActivity(chaos) {
  if (!chaos || typeof chaos !== 'object') return false;
  return ['injected', 'healed', 'duplicateWrites'].some((field) => (
    Number.isInteger(chaos[field]) && chaos[field] > 0
  ));
}

/**
 * One line for effect throughput. The panel shows it once a counter has
 * moved, the same way the chaos line stays quiet at zero.
 *
 * @param {{applied?: number, deduped?: number, retried?: number}|null|undefined} metrics
 * @returns {string}
 */
export function effectMetricsSummary(metrics) {
  const applied = Number.isInteger(metrics?.applied) && metrics.applied >= 0 ? metrics.applied : 0;
  const deduped = Number.isInteger(metrics?.deduped) && metrics.deduped >= 0 ? metrics.deduped : 0;
  const retried = Number.isInteger(metrics?.retried) && metrics.retried >= 0 ? metrics.retried : 0;
  return `${applied} applied, ${deduped} deduped, ${retried} retried`;
}

/**
 * True when the panel should show the throughput line.
 *
 * @param {{applied?: number, deduped?: number, retried?: number}|null|undefined} metrics
 * @returns {boolean}
 */
export function hasEffectMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return false;
  return ['applied', 'deduped', 'retried'].some((field) => (
    Number.isInteger(metrics[field]) && metrics[field] > 0
  ));
}

/**
 * @param {string|undefined} status
 * @returns {boolean}
 */
export function isRunning(status) {
  // `awaiting-review` is paused, but the panel keeps polling so a reply
  // shows up without a manual refresh.
  return status === 'running' || status === 'awaiting-review';
}

/**
 * @param {string|undefined} status
 * @returns {boolean}
 */
export function canRetry(status) {
  return status === 'failed' || status === 'blocked';
}

/**
 * Lozenge colour for a flight-recorder marker or event kind.
 *
 * @param {string|undefined} kind
 * @returns {'default'|'inprogress'|'moved'|'new'|'removed'|'success'}
 */
export function eventAppearance(kind) {
  if (kind === 'self-heal' || kind === 'watchdog.self-heal') {
    return 'moved';
  }
  if (kind === 'retry' || kind === 'step.retried' || kind === 'replan') {
    return 'new';
  }
  if (kind === 'step.failed') {
    return 'removed';
  }
  if (kind === 'step.succeeded' || kind === 'effect.written' || kind === 'memory.written') {
    return 'success';
  }
  if (kind === 'step.started' || kind === 'wave_started') {
    return 'inprogress';
  }
  if (kind === 'lead_decision' || kind === 'lead') {
    return 'new';
  }
  if (kind === 'digest_written' || kind === 'digest' || kind === 'wave') {
    return 'inprogress';
  }
  return 'default';
}

/**
 * Lines for one sub-agent card. Empty when the step has no brief yet.
 * The panel prints these with UI Kit `Text`. There is no HTML in here.
 *
 * @param {{idx?: number, skill?: string, workerType?: string, brief?: {objective?: string, allowedTools?: string[], doneWhen?: string, budget?: {maxToolCalls?: number, maxOutputBytes?: number, maxRepairAttempts?: number, dependsOn?: number[], upstream?: string}}}} step
 * @returns {string[]}
 */
export function subAgentLines(step) {
  const brief = step?.brief;
  if (!brief || typeof brief !== 'object') return [];
  const tools = Array.isArray(brief.allowedTools) && brief.allowedTools.length > 0
    ? brief.allowedTools.join(', ')
    : 'none';
  const budget = brief.budget || {};
  const label = step.skill || step.workerType || 'step';
  const lines = [
    `${step.idx ?? ''}. ${label}: ${brief.objective || ''}`,
    `Tools: ${tools}`,
    `Done when: ${brief.doneWhen || ''}`,
    `Budget: ${budget.maxToolCalls ?? 0} tool calls, ${budget.maxOutputBytes ?? 0} output bytes, ${budget.maxRepairAttempts ?? 1} repair`,
  ];
  if (Array.isArray(brief.dependsOn) && brief.dependsOn.length > 0) {
    lines.push(`Depends on: ${brief.dependsOn.join(', ')}`);
  }
  if (typeof brief.upstream === 'string' && brief.upstream.length > 0) {
    lines.push(`Upstream: ${brief.upstream}`);
  }
  return lines;
}
