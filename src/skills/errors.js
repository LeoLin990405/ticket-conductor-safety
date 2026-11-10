/**
 * Errors raised by the skill library and the sub-agent harness (WP15).
 *
 * A skill-contract failure is a blocked step, not a crash of the consumer.
 * The step worker looks at `status === 'blocked'` and reports that status so
 * the run state machine blocks the run. Ordinary worker bugs stay `failed`.
 *
 * @module skills/errors
 */

/**
 * The skill file, the brief, or the structured output broke its contract.
 */
export class SkillContractError extends Error {
  /**
   * @param {string} message
   * @param {{code: string, details?: string[]}} info
   */
  constructor(message, info) {
    super(message);
    this.name = 'SkillContractError';
    this.code = info.code;
    /** The step worker maps this to `reportStep({ status: 'blocked' })`. */
    this.status = 'blocked';
    this.details = info.details;
  }
}

/**
 * A skill pack on disk could not be parsed. This is an authoring error.
 * `plan-split` and `recall-memory` surface it as a JSON error instead of
 * planning with a half-read library.
 */
export class SkillLibraryError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, file?: string}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'SkillLibraryError';
    this.code = info.code || 'SKILL_FILE_INVALID';
    this.file = info.file;
  }
}
