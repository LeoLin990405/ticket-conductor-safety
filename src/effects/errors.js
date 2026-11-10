/**
 * Error types for the WP2 idempotent effects queue.
 *
 * Every error has a stable `code` so callers (workers, actions, watchdog) can
 * decide whether to retry without parsing message text.
 *
 * @module effects/errors
 */

/**
 * Base class for all effects-package errors.
 */
export class EffectError extends Error {
  /**
   * @param {string} message Human-readable message.
   * @param {string} code Stable machine-readable code.
   * @param {Record<string, unknown>} [details] Extra structured context.
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    Object.assign(this, details);
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Thrown before anything is written when an effect input is malformed.
 */
export class EffectValidationError extends EffectError {
  /**
   * @param {string} message Human-readable message.
   * @param {Record<string, unknown>} [details] Extra structured context.
   */
  constructor(message, details = {}) {
    super(message, 'EFFECT_VALIDATION', details);
  }
}

/**
 * Thrown when a Jira call fails or returns an unusable response.
 *
 * `status` is the HTTP status when one was available. The applier catches this
 * error, records the attempt, and either re-pushes the event with a delay or
 * marks the effect failed.
 */
export class EffectApplyError extends EffectError {
  /**
   * @param {string} message Human-readable message.
   * @param {{status?: number, kind?: string, body?: string}} [details]
   *   HTTP status, effect kind, and a short response body for logs.
   */
  constructor(message, details = {}) {
    super(message, 'EFFECT_APPLY_FAILED', details);
    this.retryable = details.status === undefined || details.status >= 500 ||
      details.status === 429;
  }
}
