/**
 * Deterministic request keys for Jira mutations (WP2).
 *
 * A request key is the identity of one intended Jira mutation:
 *
 *   sha256("<runId>|<stepId>|<kind>|<discriminator>")
 *
 * The discriminator is deliberately independent of the worker attempt number.
 * A retried step or a duplicate queue delivery therefore produces the same key,
 * and the effect is applied at most once.
 *
 * @module effects/requestKey
 */

import { createHash } from 'node:crypto';

import { EFFECT_KINDS } from '../store/types.js';
import { EffectValidationError } from './errors.js';

/**
 * Stable JSON serialisation for object/array discriminators.
 *
 * Plain `JSON.stringify` preserves insertion order, so two logically equal
 * objects built with different key order would hash differently. Sorting keys
 * makes the request key deterministic for callers that pass a structured
 * discriminator.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Convert a discriminator to the text that participates in the hash.
 *
 * - `undefined`/`null` become the empty string, which is convenient for
 *   effects where one key per (run, step, kind) is enough.
 * - Strings are used verbatim. This keeps the documented pipe format readable
 *   and matches hand-computed test vectors.
 * - Numbers and booleans use their normal string form.
 * - Objects and arrays use stable JSON so key order cannot change the key.
 *
 * @param {unknown} discriminator
 * @returns {string}
 */
export function normalizeDiscriminator(discriminator) {
  if (discriminator === undefined || discriminator === null) {
    return '';
  }
  if (typeof discriminator === 'string') {
    return discriminator;
  }
  if (typeof discriminator === 'number' || typeof discriminator === 'boolean') {
    return String(discriminator);
  }
  if (typeof discriminator === 'object') {
    return stableStringify(discriminator);
  }
  throw new EffectValidationError(
    'discriminator must be a string, number, boolean, object, or array',
  );
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{optional?: boolean}} [options]
 * @returns {string|undefined}
 */
function readString(value, field, options = {}) {
  if (value === undefined || value === null) {
    if (options.optional) {
      return undefined;
    }
    throw new EffectValidationError(`${field} is required`);
  }
  if (typeof value !== 'string') {
    throw new EffectValidationError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new EffectValidationError(`${field} must not be empty`);
  }
  return value;
}

/**
 * Build the deterministic sha256 request key for an intended Jira mutation.
 *
 * `stepId` is optional only for run-level effects (for example the Epic memory
 * comment written after a run completes). Omitting it produces an empty
 * segment in the hash input, which keeps the documented pipe format intact.
 *
 * @param {{
 *   runId: string,
 *   stepId?: string,
 *   kind: string,
 *   discriminator?: unknown,
 * }} input
 * @returns {string} Lower-case sha256 hex digest.
 *
 * @example
 * requestKeyFor({
 *   runId: 'run-1',
 *   stepId: 'step-1',
 *   kind: 'createIssue',
 *   discriminator: 'child-issue',
 * });
 */
export function requestKeyFor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new EffectValidationError('requestKeyFor expects an object');
  }
  const source = /** @type {Record<string, unknown>} */ (input);
  const runId = readString(source.runId, 'runId');
  const stepId = readString(source.stepId, 'stepId', { optional: true }) ?? '';
  const kind = readString(source.kind, 'kind');
  if (!EFFECT_KINDS.includes(kind)) {
    throw new EffectValidationError(
      `kind must be one of ${EFFECT_KINDS.join(', ')}; received ${kind}`,
    );
  }
  const discriminator = normalizeDiscriminator(source.discriminator);
  return createHash('sha256')
    .update(`${runId}|${stepId}|${kind}|${discriminator}`, 'utf8')
    .digest('hex');
}
