/**
 * Custom Entity `integer` attributes are signed 32-bit values.
 * Epoch milliseconds (about 1.7e12 in 2026) do not fit.
 * The storage probe and the unit test both use this helper so the
 * cutoff stays in one place.
 *
 * Source: https://developer.atlassian.com/platform/forge/storage-reference/entities-manifest/
 */

export const ENTITY_INTEGER_MIN = -2147483648;
export const ENTITY_INTEGER_MAX = 2147483647;

/**
 * @param {number} epochMs Unix time in milliseconds.
 * @returns {boolean} True only when the value is a safe 32-bit signed integer.
 */
export function epochMsFitsEntityInteger(epochMs) {
  return Number.isInteger(epochMs)
    && epochMs >= ENTITY_INTEGER_MIN
    && epochMs <= ENTITY_INTEGER_MAX;
}
