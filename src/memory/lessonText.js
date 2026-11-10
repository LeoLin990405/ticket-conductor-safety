/**
 * Text format for planner lessons and the plan card that cites them.
 *
 * Lessons are stored in the existing WP1 `memory` entity. No attribute is
 * removed. Votes, status, confidence, tier, and the validity window travel
 * inside the text, after a stable prefix, because those are not queried in
 * Forge storage. `validUntil` (a float) is still the expiry column, and this
 * module never asks KVS to filter on it. Callers load the project index and
 * decide in process.
 *
 * Two pools share the entity:
 * - a Jira project, `projectKey` such as `PAY`
 * - the global pool, `projectKey` `__global__`
 *
 * A lesson is expired by setting `validUntil` or by superseding it. The row
 * stays, so a replay can ask which version held at an earlier timestamp.
 *
 * @module memory/lessonText
 */

import { normalizeText } from './scoring.js';

/** Prefix on a planner-rule lesson. The prose summary comes before it. */
export const LESSON_PREFIX = '[Conductor lesson]';

/**
 * Prefix on the note that records which memories a plan actually used.
 * Recall hides these so a citation cannot be recalled as a new lesson.
 */
export const APPLIED_PREFIX = '[Conductor applied]';

/** Header of the Epic comment that cites the lessons a plan used. */
export const PLAN_CARD_HEADER = '[Conductor plan]';

/**
 * Partition key for the global memory pool. It is not a Jira project key.
 * Recall reads this pool in addition to the current project.
 */
export const GLOBAL_PROJECT_KEY = '__global__';

/**
 * Maximum UTF-8 bytes of memory text injected into one plan.
 * WP15 caps injection at 1.5 KB so a recall cannot blow the Rovo context
 * or the 64 KiB value cap with a single plan.
 *
 * @constant {number}
 */
export const RECALL_BUDGET_BYTES = 1536;

/** Lesson lifecycle stored in the envelope. Expired is derived, not stored. */
export const LESSON_STATUSES = Object.freeze([
  'proposed',
  'accepted',
  'rejected',
]);

/**
 * @param {string} text
 * @returns {number}
 */
export function utf8Size(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/**
 * Shorten `text` so its UTF-8 size is at most `budgetBytes`.
 * The ellipsis is included in the budget.
 *
 * @param {string} text
 * @param {number} budgetBytes
 * @returns {string}
 */
export function truncateUtf8(text, budgetBytes) {
  const value = String(text ?? '');
  if (budgetBytes <= 0) {
    return '';
  }
  if (utf8Size(value) <= budgetBytes) {
    return value;
  }
  const ellipsis = '…';
  const mark = utf8Size(ellipsis);
  const limit = Math.max(0, budgetBytes - mark);
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const size = utf8Size(char);
    if (bytes + size > limit) {
      break;
    }
    bytes += size;
    end += char.length;
  }
  return `${value.slice(0, end)}${ellipsis}`;
}

/**
 * @param {unknown} text
 * @param {string} prefix
 * @returns {object|null}
 */
export function parseTagged(text, prefix) {
  if (typeof text !== 'string') {
    return null;
  }
  const at = text.indexOf(prefix);
  if (at === -1) {
    return null;
  }
  const json = text.slice(at + prefix.length).trim();
  if (!json.startsWith('{')) {
    return null;
  }
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * @param {object|null|undefined} memory
 * @returns {object|null}
 */
export function parseLesson(memory) {
  const body = parseTagged(memory?.text, LESSON_PREFIX);
  if (!body || body.v !== 1 || typeof body.dedupeKey !== 'string') {
    return null;
  }
  if (!LESSON_STATUSES.includes(body.status)) {
    return null;
  }
  return body;
}

/**
 * Prose half of a lesson, the part a human and the keyword scorer read.
 *
 * @param {object|null|undefined} memory
 * @returns {string}
 */
export function lessonSummary(memory) {
  const text = typeof memory?.text === 'string' ? memory.text : '';
  const at = text.indexOf(LESSON_PREFIX);
  return (at === -1 ? text : text.slice(0, at)).trim();
}

/**
 * @param {string} summary
 * @param {object} envelope
 * @returns {string}
 */
export function buildLessonText(summary, envelope) {
  return `${String(summary).trim()}\n${LESSON_PREFIX} ${JSON.stringify(envelope)}`;
}

/**
 * @param {object|null|undefined} memory
 * @returns {boolean}
 */
export function isAppliedNote(memory) {
  return typeof memory?.text === 'string' && memory.text.startsWith(APPLIED_PREFIX);
}

/**
 * Notes about a plan must not be recalled as if they were new lessons.
 *
 * @param {object|null|undefined} memory
 * @returns {boolean}
 */
export function isHiddenFromRecall(memory) {
  return isAppliedNote(memory);
}

/**
 * @param {object} payload
 * @returns {string}
 */
export function buildAppliedText(payload) {
  return `${APPLIED_PREFIX} ${JSON.stringify(payload)}`;
}

/**
 * @param {object|null|undefined} memory
 * @returns {object|null}
 */
export function parseApplied(memory) {
  if (!isAppliedNote(memory)) {
    return null;
  }
  const body = parseTagged(memory.text, APPLIED_PREFIX);
  if (!body) {
    return null;
  }
  return body;
}

/**
 * Confidence used when a memory has no lesson envelope.
 * Decisions are human-confirmed, so they start higher than facts.
 *
 * @param {string|undefined} memType
 * @returns {number}
 */
export function defaultConfidence(memType) {
  if (memType === 'decision') {
    return 0.75;
  }
  if (memType === 'lesson') {
    return 0.6;
  }
  return 0.5;
}

/**
 * Identity used to dedupe lessons inside one pool.
 * The same cause on the same project and worker is one lesson, not a pile
 * of near-copies (mem0 NOOP / ExpeL edit).
 *
 * @param {{tier: string, projectKey?: string, kind?: string, workerType?: string, cause: string}} input
 * @returns {string}
 */
export function dedupeKeyFor(input) {
  return [
    input.tier,
    input.projectKey || '',
    input.kind || 'lesson',
    input.workerType || '',
    normalizeText(input.cause),
  ].join('|');
}

/**
 * When a version was valid. `validTo` 0 means it is still open.
 * A superseded row ends when its successor starts. Nothing is deleted.
 *
 * @param {object} memory
 * @param {Map<string, object>} byId
 * @returns {{validFrom: number, validTo: number}}
 */
export function temporalBounds(memory, byId) {
  const parsed = parseLesson(memory);
  const validFrom = typeof parsed?.validFrom === 'number'
    ? parsed.validFrom
    : (typeof memory?.createdAt === 'number' ? memory.createdAt : 0);
  let validTo = 0;
  if (typeof memory?.validUntil === 'number' && memory.validUntil !== 0) {
    validTo = memory.validUntil;
  } else if (typeof parsed?.validTo === 'number' && parsed.validTo !== 0) {
    validTo = parsed.validTo;
  }
  if (memory?.supersededBy) {
    const successor = byId.get(memory.supersededBy);
    const ended = typeof successor?.createdAt === 'number'
      ? successor.createdAt
      : validFrom;
    validTo = validTo === 0 ? ended : Math.min(validTo, ended);
  }
  return { validFrom, validTo };
}

/**
 * True when this version was the one a replay at `asOf` should see.
 * The successor's `createdAt` belongs to the successor, not to this row.
 *
 * @param {object} memory
 * @param {Map<string, object>} byId
 * @param {number} asOf
 * @returns {boolean}
 */
export function activeAt(memory, byId, asOf) {
  const { validFrom, validTo } = temporalBounds(memory, byId);
  if (asOf < validFrom) {
    return false;
  }
  if (validTo !== 0 && asOf >= validTo) {
    return false;
  }
  return true;
}

/** Outcomes a lesson can come from. @constant {ReadonlyArray<string>} */
export const LESSON_OUTCOMES = Object.freeze(['blocked', 'failed', 'retried', 'succeeded']);

/**
 * The run outcome a lesson came from. An explicit `outcome` wins; otherwise
 * it follows the lesson kind. Manual and legacy lessons keep `blocked`.
 *
 * @param {{outcome?: string, kind?: string, status?: string}} [source]
 * @returns {'blocked'|'failed'|'retried'|'succeeded'}
 */
export function lessonOutcome(source = {}) {
  if (LESSON_OUTCOMES.includes(source.outcome)) {
    return /** @type {any} */ (source.outcome);
  }
  if (source.kind === 'summarize') return 'succeeded';
  if (source.kind === 'watchdog-retry') return 'retried';
  if (source.kind === 'step-failed') return 'failed';
  return 'blocked';
}

/**
 * "last run blocked on X" only when it did block. The wording follows the outcome.
 *
 * @param {string} cause
 * @param {string} [outcome]
 * @returns {string}
 */
export function outcomeClause(cause, outcome = 'blocked') {
  if (outcome === 'succeeded') return `last run succeeded and noted: ${cause}`;
  if (outcome === 'retried') return `last run needed a watchdog retry on ${cause}`;
  if (outcome === 'failed') return `last run failed on ${cause}`;
  return `last run blocked on ${cause}`;
}

/**
 * @param {string} cause
 * @param {'prepend'|'annotate'|'full'|'moved'} mode
 * @param {string} [outcome]
 * @returns {string}
 */
export function lessonHow(cause, mode, outcome = 'blocked') {
  const clause = outcomeClause(cause, outcome);
  if (mode === 'moved') {
    return `${clause}, so moved the check-deps step to the front`;
  }
  if (mode === 'annotate') {
    return `${clause}, so the check-deps step cites this lesson`;
  }
  if (mode === 'full') {
    return `${clause}, so the plan was already at 8 steps and the first step was told to check dependencies before continuing`;
  }
  return `${clause}, so added a check-deps step first`;
}

/**
 * Citation the plan card, the Epic comment, and the step input all share.
 * The lesson id is the memory id of the version that was applied.
 *
 * @param {{lessonId: string, confidence?: number, scope?: string}} lesson
 * @param {string} how
 * @returns {string}
 */
export function lessonCitation(lesson, how) {
  const confidence = Number(lesson.confidence ?? 0).toFixed(2);
  const scope = lesson.scope || 'project';
  return `Lesson ${lesson.lessonId} (confidence ${confidence}, scope ${scope}): ${how}`;
}

/**
 * @param {string} planCard Lines already joined, without the header.
 * @returns {{bodyText: string, bodyAdf: object}}
 */
export function buildPlanCardComment(planCard) {
  const lines = String(planCard)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const bodyText = [PLAN_CARD_HEADER, ...lines].join('\n');
  return {
    bodyText,
    bodyAdf: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: PLAN_CARD_HEADER }],
        },
        ...lines.map((line) => ({
          type: 'paragraph',
          content: [{ type: 'text', text: line }],
        })),
      ],
    },
  };
}

/**
 * Pull a stable "missing access to X" cause out of a worker or Jira error.
 * Other failures still get a cause string so the next plan can cite them.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessageOf(error) {
  if (error === undefined || error === null) {
    return '';
  }
  if (typeof error === 'string') {
    return error.trim();
  }
  if (typeof error === 'object' && typeof error.message === 'string') {
    return error.message.trim();
  }
  return '';
}

/**
 * @param {string} message
 * @returns {string|null}
 */
export function accessCause(message) {
  const patterns = [
    /missing access to\s+([^.\n;]+)/i,
    /no access to\s+([^.\n;]+)/i,
    /access denied to\s+([^.\n;]+)/i,
    /not authorized to access\s+([^.\n;]+)/i,
    /permission denied for\s+([^.\n;]+)/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match && match[1]) {
      const subject = match[1].trim().replace(/\s+/g, ' ');
      if (/^missing access to/i.test(pattern.source)) {
        return `missing access to ${subject}`;
      }
      if (/^no access to/i.test(pattern.source)) {
        return `missing access to ${subject}`;
      }
      return `missing access to ${subject}`;
    }
  }
  return null;
}

/**
 * @param {string} value
 * @param {number} max
 * @returns {string}
 */
export function clipText(value, max) {
  const text = String(value ?? '').trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
