/**
 * Error types raised by the Ticket Conductor store.
 *
 * Every error carries a stable `code` so callers (actions, workers, UI
 * resolvers) can branch without matching message text.
 *
 * @module store/errors
 */

import { MAX_VALUE_BYTES, MAX_VALUE_LABEL } from './types.js';

/**
 * Base class for all store errors.
 */
export class StoreError extends Error {
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
 * Thrown when an optimistic update loses a race. `expectedUpdatedAt` is the
 * value the caller supplied and `actualUpdatedAt` is the value currently in
 * storage (or null when the row disappeared).
 */
export class ConflictError extends StoreError {
  /**
   * @param {string} entityName Entity name, e.g. `run`.
   * @param {string} key Entity key.
   * @param {number|undefined} expectedUpdatedAt Value supplied by the caller.
   * @param {number|null} actualUpdatedAt Value currently stored.
   */
  constructor(entityName, key, expectedUpdatedAt, actualUpdatedAt) {
    super(
      `${entityName} ${key} update conflict: expected updatedAt ` +
        `${String(expectedUpdatedAt)}, actual ${String(actualUpdatedAt)}`,
      'CONFLICT',
      { entityName, key, expectedUpdatedAt, actualUpdatedAt },
    );
  }
}

/**
 * Thrown when an update targets a record that does not exist.
 */
export class NotFoundError extends StoreError {
  /**
   * @param {string} entityName Entity name, e.g. `step`.
   * @param {string} key Entity key.
   */
  constructor(entityName, key) {
    super(`${entityName} ${key} not found`, 'NOT_FOUND', { entityName, key });
  }
}

/**
 * Thrown for invalid input before anything is written.
 */
export class StoreValidationError extends StoreError {
  /**
   * @param {string} message Human-readable message.
   * @param {Record<string, unknown>} [details] Extra structured context.
   */
  constructor(message, details = {}) {
    super(message, 'VALIDATION', details);
  }
}

/**
 * Thrown when a single value exceeds the app-level 64 KiB cap.
 *
 * The platform permits 240 KiB per entity value; Ticket Conductor keeps a
 * stricter cap so a step output or effect payload can never crowd out the
 * rest of a record. Callers should store a Jira comment reference instead.
 */
export class ValueTooLargeError extends StoreValidationError {
  /**
   * @param {string} entityName Entity name, e.g. `step`.
   * @param {string} field Field whose value is too large.
   * @param {number} bytes Measured UTF-8 or JSON byte length.
   * @param {number} [limit] Maximum allowed bytes.
   */
  constructor(entityName, field, bytes, limit = MAX_VALUE_BYTES) {
    super(
      `${entityName}.${field} is ${bytes} bytes, which exceeds the ` +
        `${limit}-byte (${MAX_VALUE_LABEL}) value limit`,
      { entityName, field, bytes, limit },
    );
    this.code = 'VALUE_TOO_LARGE';
    this.name = 'ValueTooLargeError';
  }
}
