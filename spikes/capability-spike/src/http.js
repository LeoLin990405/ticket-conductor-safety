import { timingSafeEqual } from 'node:crypto';

/**
 * Web trigger requests are unauthenticated at the platform.
 * https://developer.atlassian.com/platform/forge/manifest-reference/modules/web-trigger/
 * The spike therefore requires a bearer token that matches the encrypted
 * Forge variable SPIKE_TOKEN. Header values arrive as arrays of strings.
 * https://developer.atlassian.com/platform/forge/runtime-reference/web-trigger/
 */

/**
 * @param {Record<string, string[]>} headers
 * @param {string} name
 * @returns {string}
 */
export function headerValue(headers, name) {
  if (!headers) {
    return '';
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) {
      continue;
    }
    if (Array.isArray(value)) {
      return value[0] || '';
    }
    return value ? String(value) : '';
  }
  return '';
}

/**
 * @param {string} presented
 * @param {string} expected
 * @returns {boolean}
 */
export function bearerMatches(presented, expected) {
  const prefix = 'Bearer ';
  if (!presented.startsWith(prefix) || !expected) {
    return false;
  }
  const token = presented.slice(prefix.length);
  const got = Buffer.from(token);
  const want = Buffer.from(expected);
  if (got.length !== want.length || got.length === 0) {
    return false;
  }
  return timingSafeEqual(got, want);
}

/**
 * Dynamic web triggers must return statusCode plus a string body.
 * Header values are arrays.
 * https://developer.atlassian.com/platform/forge/runtime-reference/web-trigger/
 *
 * @param {number} statusCode
 * @param {unknown} payload
 */
export function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': ['application/json'],
    },
    body: JSON.stringify(payload),
  };
}

/**
 * @param {{ queryParameters?: Record<string, string[]> }} request
 * @param {string} name
 * @returns {string}
 */
export function queryValue(request, name) {
  const values = request.queryParameters && request.queryParameters[name];
  if (!values || !values.length) {
    return '';
  }
  return values[0];
}
