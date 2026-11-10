/**
 * Fold comment effects that share one Jira issue into one effect.
 *
 * A step worker can return several comment descriptors for the same child
 * in one completion (the worker's output, plus a status note, for example).
 * Each descriptor would otherwise become its own `effect-queue` message and
 * its own `POST /rest/api/3/issue/{key}/comment`. Jira rate-limits those
 * writes. This function turns that list into one comment before anything is
 * enqueued, so the applier makes one POST and stores one comment id.
 *
 * The request key stays `sha256(runId|stepId|comment|discriminator)`. The
 * discriminator of a batch is `batch:` plus the part names sorted and joined
 * with `+`. Sorting means a retry that hands the same parts back in a
 * different order still hashes to the same key, and `putEffectIfAbsent`
 * does not push a second message. A single comment is returned unchanged,
 * discriminator and all, so `research-comment` and the chaos 429 aimed at
 * it stay the same key.
 *
 * What this function does not do, on purpose:
 * - It does not look at the store. Finding a sibling comment with a query
 *   would add a KVS read on every comment, including the ones that are
 *   already alone.
 * - It does not edit a comment that has already been applied. A second
 *   Jira call to update that comment would be a new mutation, and undo
 *   would no longer know which id to delete.
 * - It does not merge comments that name different issues. The Epic wave
 *   report, the plan citation, the memory comment, and the watchdog failure
 *   note are separate writes. They are posted at different times, and the
 *   wave report has to be on the Epic before a person replies. They are
 *   not in the list this function sees.
 *
 * Undo deletes the one comment id this batch produced, which removes every
 * part. A merged payload that would not fit in the 64 KiB effect field is
 * left as separate comments, so a large pair still posts instead of failing
 * the step.
 *
 * @module effects/commentBatch
 */

import { MAX_VALUE_BYTES } from '../store/types.js';
import { textToAdf } from './jira.js';

const textEncoder = new TextEncoder();

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function asNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

/**
 * UTF-8 size of one stored payload, using the same JSON rule as the store's
 * 64 KiB cap. A value that cannot be serialised is treated as too big so
 * the caller keeps the original comments.
 *
 * @param {unknown} value
 * @returns {number}
 */
function jsonBytes(value) {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') return MAX_VALUE_BYTES + 1;
    return textEncoder.encode(json).length;
  } catch {
    return MAX_VALUE_BYTES + 1;
  }
}

/**
 * Plain text from an ADF tree, for a part that set `bodyAdf` and not
 * `bodyText`. Blocks are separated by a newline so two sections do not
 * run together in the stored plain copy.
 *
 * @param {unknown} node
 * @returns {string}
 */
function adfPlain(node) {
  if (!node || typeof node !== 'object') return '';
  const record = /** @type {Record<string, unknown>} */ (node);
  if (record.type === 'text' && typeof record.text === 'string') return record.text;
  if (!Array.isArray(record.content)) return '';
  return record.content.map((child) => adfPlain(child)).filter((part) => part.length > 0).join('\n');
}

/**
 * ADF blocks for one part. A real document's `content` is kept. A part
 * that only has `bodyText` becomes one paragraph, which is what
 * `textToAdf` posts for a comment that has no `bodyAdf`.
 *
 * @param {Record<string, unknown>} payload
 * @param {string} plain
 * @returns {object[]}
 */
function blocksOf(payload, plain) {
  const adf = payload.bodyAdf;
  if (adf && typeof adf === 'object' && !Array.isArray(adf)) {
    const content = /** @type {{content?: unknown}} */ (adf).content;
    if (Array.isArray(content) && content.length > 0) {
      return content.filter((block) => block && typeof block === 'object');
    }
  }
  if (plain.length === 0) return [];
  return textToAdf(plain).content;
}

/**
 * The issue this comment will land on, or `null` when the target is not
 * known yet. Two comments bucket together only when this string matches.
 *
 * A deferred comment (`childOfStepId`, no `issueKey`) names the step whose
 * child it belongs to. Once that step already has `childIssueKey`, it is
 * the same target as a comment that names the key directly. Comments with
 * neither field are not batched: we cannot prove they share an issue.
 *
 * @param {Record<string, unknown>} effect
 * @param {Record<string, unknown>|null|undefined} step
 * @returns {string|null}
 */
function commentTarget(effect, step) {
  const payload = asRecord(effect.payload);
  const issueKey = asNonEmptyString(payload.issueKey);
  if (issueKey) return `issue:${issueKey}`;
  const deferred = asNonEmptyString(payload.childOfStepId);
  if (!deferred) return null;
  const stepId = asNonEmptyString(step?.stepId);
  const childIssueKey = asNonEmptyString(step?.childIssueKey);
  if (stepId && deferred === stepId && childIssueKey) {
    return `issue:${childIssueKey}`;
  }
  return `step:${deferred}`;
}

/**
 * Fill in the discriminator the enqueue loop would have used, so removing
 * a later comment from the list cannot change the key of a comment that
 * is left on its own. Effects that already name a discriminator are
 * returned as the same object.
 *
 * @param {unknown} effect
 * @param {number} index
 * @returns {unknown}
 */
function stampDiscriminator(effect, index) {
  if (!effect || typeof effect !== 'object' || Array.isArray(effect)) return effect;
  const record = /** @type {Record<string, unknown>} */ (effect);
  if (typeof record.discriminator === 'string' && record.discriminator.length > 0) {
    return effect;
  }
  const kind = typeof record.kind === 'string' && record.kind.length > 0
    ? record.kind
    : 'effect';
  return { ...record, discriminator: `${kind}:${index}` };
}

/**
 * One comment effect for `parts`, or `null` when the parts should stay
 * separate. `null` covers an empty body and a payload that would not fit
 * in the effect field.
 *
 * @param {Array<Record<string, unknown>>} parts
 * @param {Record<string, unknown>|null|undefined} step
 * @returns {Record<string, unknown>|null}
 */
function mergeCommentEffects(parts, step) {
  /** @type {string[]} */
  const names = [];
  /** @type {string[]} */
  const texts = [];
  /** @type {object[]} */
  const blocks = [];
  let issueKey = '';
  let childOfStepId = '';

  for (const part of parts) {
    const name = asNonEmptyString(part.discriminator);
    if (name) names.push(name);
    const payload = asRecord(part.payload);
    const key = asNonEmptyString(payload.issueKey);
    const deferred = asNonEmptyString(payload.childOfStepId);
    if (!issueKey && key) issueKey = key;
    if (!childOfStepId && deferred) childOfStepId = deferred;
    const ownText = typeof payload.bodyText === 'string' ? payload.bodyText : '';
    const plain = ownText.length > 0 ? ownText : adfPlain(payload.bodyAdf);
    if (plain.length > 0) texts.push(plain);
    blocks.push(...blocksOf(payload, plain));
  }

  if (texts.length === 0 && blocks.length === 0) return null;
  if (!issueKey && childOfStepId && childOfStepId === asNonEmptyString(step?.stepId)) {
    issueKey = asNonEmptyString(step?.childIssueKey);
  }
  if (!issueKey && !childOfStepId) return null;

  // The first part may carry fields the applier ignores. Keep them so a
  // caller that stashed something next to the body does not lose it.
  // `dependsOnKeys` is a compensation wait-list, not a comment field, and
  // copying it would make the applier postpone the POST.
  const payload = { ...asRecord(parts[0].payload) };
  delete payload.bodyText;
  delete payload.bodyAdf;
  delete payload.issueKey;
  delete payload.childOfStepId;
  delete payload.batchedFrom;
  delete payload.dependsOnKeys;
  if (issueKey) payload.issueKey = issueKey;
  else payload.childOfStepId = childOfStepId;
  if (texts.length > 0) payload.bodyText = texts.join('\n\n');
  if (blocks.length > 0) {
    payload.bodyAdf = { type: 'doc', version: 1, content: blocks };
  }
  // Worker order, so a reader can see which section was written first.
  // The request-key discriminator sorts the same names.
  payload.batchedFrom = names.slice();

  if (jsonBytes(payload) > MAX_VALUE_BYTES) return null;

  const sorted = names.slice().sort();
  return {
    kind: 'comment',
    payload,
    discriminator: `batch:${sorted.join('+')}`,
  };
}

/**
 * Coalesce comment effects that share a target. Every other effect stays
 * where it was, including a comment whose issue we cannot name and a
 * transition that sits between two comments.
 *
 * `step` is the step that is finishing. Pass it when the caller has it so
 * a deferred comment and a comment that already names `childIssueKey` can
 * share a bucket. Omit it from a caller that only has the effect list;
 * deferred comments then batch only with the same `childOfStepId`.
 *
 * @param {Array<unknown>} effects
 * @param {{stepId?: string, childIssueKey?: string}|null} [step]
 * @returns {Array<unknown>}
 */
export function coalesceCommentEffects(effects, step) {
  const list = Array.isArray(effects) ? effects : [];
  const stamped = list.map((effect, index) => stampDiscriminator(effect, index));
  const context = asRecord(step);

  /** @type {Map<string, number[]>} */
  const groups = new Map();
  stamped.forEach((effect, index) => {
    const record = asRecord(effect);
    if (record.kind !== 'comment') return;
    const target = commentTarget(record, context);
    if (!target) return;
    const bucket = groups.get(target);
    if (bucket) bucket.push(index);
    else groups.set(target, [index]);
  });

  /** @type {Set<number>} */
  const drop = new Set();
  /** @type {Map<number, Record<string, unknown>>} */
  const replacements = new Map();
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    const parts = indexes.map((index) => asRecord(stamped[index]));
    const merged = mergeCommentEffects(parts, context);
    if (!merged) continue;
    replacements.set(indexes[0], merged);
    for (let cursor = 1; cursor < indexes.length; cursor += 1) {
      drop.add(indexes[cursor]);
    }
  }

  /** @type {Array<unknown>} */
  const coalesced = [];
  stamped.forEach((effect, index) => {
    if (drop.has(index)) return;
    coalesced.push(replacements.get(index) ?? effect);
  });
  return coalesced;
}
