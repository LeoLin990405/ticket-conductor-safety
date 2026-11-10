/**
 * Wave digests for the SuperAgent lead loop (WP14).
 *
 * A wave is the set of steps that share a `wave` number. Plan-split writes
 * wave 1. The lead may add wave 2 and wave 3 after that. The automatic
 * `summarize` step is not part of any wave.
 *
 * The lead, and every later wave, read a digest instead of the full step
 * output. Full text stays on the step row and on the child issue. The digest
 * is capped at about 1 KB so it fits in a Forge entity value with room to
 * spare (the store rejects a single field over 64 KiB; the platform limit
 * is 240 KiB).
 *
 * @module run/digest
 */

/** UTF-8 budget for one wave digest. @constant {number} */
export const DIGEST_BYTE_BUDGET = 1024;

/** Hard cap. The lead cannot open a fourth wave. @constant {number} */
export const MAX_WAVES = 3;

/**
 * Hard cap on planned steps, excluding the automatic summarize step.
 * Same number `plan-split` already enforces.
 * @constant {number}
 */
export const MAX_STEPS = 8;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/**
 * @param {string} value
 * @returns {number}
 */
export function utf8Bytes(value) {
  return encoder.encode(String(value ?? '')).length;
}

/**
 * Shorten `text` to at most `max` UTF-8 bytes without splitting a code point.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncateUtf8(text, max) {
  const source = String(text ?? '');
  const bytes = encoder.encode(source);
  if (bytes.length <= max) {
    return source;
  }
  const sliced = decoder.decode(bytes.slice(0, Math.max(0, max))).replace(/\uFFFD$/u, '');
  return sliced.length > 0 ? sliced : source.slice(0, 1);
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function clip(value, max) {
  const single = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (single.length === 0) {
    return '';
  }
  if (Buffer.byteLength(single, 'utf8') <= max) {
    return single;
  }
  // Cut on a word boundary and mark the cut, so the wave report never ends
  // mid-word ("schema" read as "sche"). The ellipsis is 3 bytes.
  const cut = truncateUtf8(single, Math.max(0, max - 3));
  const space = cut.lastIndexOf(' ');
  const word = space > cut.length * 0.6 ? cut.slice(0, space) : cut;
  return `${word.replace(/[\s,;:.-]+$/, '')}\u2026`;
}

/**
 * Wave number stored on the step. Rows written before WP14 have no `wave`
 * and count as wave 1, which is the plan-split wave.
 *
 * @param {{wave?: number}|null|undefined} step
 * @returns {number}
 */
export function waveOf(step) {
  return Number.isInteger(step?.wave) && step.wave > 0 ? step.wave : 1;
}

/**
 * Steps the lead is allowed to reason about. Summarize is appended after
 * the lead has already stopped the run.
 *
 * @param {Array<{workerType?: string}>|null|undefined} steps
 * @returns {Array<any>}
 */
export function workSteps(steps) {
  return (Array.isArray(steps) ? steps : []).filter(
    (step) => step && step.workerType !== 'summarize',
  );
}

/**
 * Highest wave present on the work steps. `0` when the run has none.
 *
 * @param {Array<{wave?: number, workerType?: string}>} steps
 * @returns {number}
 */
export function currentWave(steps) {
  const work = workSteps(steps);
  if (work.length === 0) {
    return 0;
  }
  return work.reduce((max, step) => Math.max(max, waveOf(step)), 1);
}

/**
 * How much new work a goal should be allowed to grow into.
 *
 * A short goal is small (one follow-up at most). A goal that names several
 * systems, or runs long, is large (up to three follow-ups in the next wave).
 * The hard caps in {@link spawnBudget} still apply.
 *
 * @param {unknown} goal
 * @returns {'small'|'medium'|'large'}
 */
export function effortScale(goal) {
  const text = String(goal ?? '').trim();
  const words = text.split(/\s+/).filter(Boolean);
  const ands = text.match(/\band\b/gi);
  const broad = /\b(migrate|migration|integrations?|security|compliance|rollout|several|multiple)\b/i
    .test(text) || (ands ? ands.length >= 2 : false);
  if (broad || words.length >= 24 || text.length > 240) {
    return 'large';
  }
  if (words.length <= 6 && text.length < 90 && !broad) {
    return 'small';
  }
  return 'medium';
}

/**
 * How many steps the next wave may add.
 *
 * `0` means the lead must stop or ask a human. It must not spawn.
 *
 * @param {{goal?: unknown, existingSteps?: number, nextWave?: number}} input
 * @returns {number}
 */
export function spawnBudget(input) {
  const nextWave = Number.isInteger(input?.nextWave) ? input.nextWave : 1;
  const existing = Number.isInteger(input?.existingSteps) ? input.existingSteps : 0;
  if (nextWave > MAX_WAVES || existing >= MAX_STEPS) {
    return 0;
  }
  const room = MAX_STEPS - existing;
  const scale = effortScale(input?.goal);
  const preferred = scale === 'small' ? 1 : scale === 'large' ? 3 : 2;
  return Math.min(preferred, room);
}

/**
 * One line of digest text for a finished step. This is the only step text
 * the lead's model is shown. Issue lists and spec bodies stay on the step.
 *
 * @param {any} step
 * @param {number} summaryBudget
 * @returns {string}
 */
function digestLine(step, summaryBudget) {
  const output = asRecord(step?.output);
  let summary = '';
  if (typeof step?.output === 'string') {
    summary = step.output;
  } else if (typeof output.summary === 'string') {
    summary = output.summary;
  } else if (typeof output.result === 'string') {
    summary = output.result;
  }
  if (Array.isArray(output.followUps) && output.followUps.length > 0) {
    const titles = output.followUps
      .map((item) => clip(item?.title, 80))
      .filter(Boolean);
    if (titles.length > 0) {
      summary = `${summary} Follow-up: ${titles.join('; ')}`.trim();
    }
  }
  if (output.askHuman === true) {
    summary = `${summary} Needs a decision.`.trim();
  }
  const title = clip(step?.title, 80) || 'step';
  const worker = clip(step?.workerType, 40) || 'worker';
  const body = clip(summary || 'completed', summaryBudget) || 'completed';
  return `${step?.idx ?? '?'} ${worker} ${title}: ${body}`;
}

/**
 * Squeeze one finished wave into a digest of at most {@link DIGEST_BYTE_BUDGET}
 * bytes. The result is what later waves and the lead read.
 *
 * @param {number} wave
 * @param {Array<any>} steps Steps in that wave (already finished).
 * @returns {{wave: number, text: string, bytes: number, stepIdxs: number[]}}
 */
export function compressWave(wave, steps) {
  const rows = (Array.isArray(steps) ? steps : [])
    .filter((step) => step && step.workerType !== 'summarize' && waveOf(step) === wave)
    .sort((left, right) => (left.idx ?? 0) - (right.idx ?? 0));
  const header = `Wave ${wave} (${rows.length} step(s))`;
  let summaryBudget = 220;
  /**
   * @returns {string}
   */
  function render() {
    return [header, ...rows.map((step) => digestLine(step, summaryBudget))].join('\n');
  }
  let text = render();
  while (utf8Bytes(text) > DIGEST_BYTE_BUDGET && summaryBudget > 24) {
    summaryBudget = Math.max(24, summaryBudget - 40);
    text = render();
  }
  if (utf8Bytes(text) > DIGEST_BYTE_BUDGET) {
    text = truncateUtf8(text, DIGEST_BYTE_BUDGET);
  }
  return {
    wave,
    text,
    bytes: utf8Bytes(text),
    stepIdxs: rows.map((step) => step.idx).filter((idx) => Number.isInteger(idx)),
  };
}
