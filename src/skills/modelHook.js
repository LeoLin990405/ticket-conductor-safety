/**
 * Skill model hook (WP15 wired to WP11).
 *
 * The default runner is `runForgeSkillModel`, which calls `@forge/llm`
 * through `completeText`. A `null` result from that runner means the model
 * was unavailable or the reply was not JSON, and the harness runs the
 * deterministic checklist.
 *
 * Tests pass a replacement with `registerSkillModel`. `resetSkillModel`
 * and `registerSkillModel(null)` put the Forge runner back. They do not
 * turn the model off; `CONDUCTOR_LLM=off` and `node --test` already make
 * `completeText` return `{ok:false}`.
 *
 * @module skills/modelHook
 */

import { runForgeSkillModel } from './forgeModel.js';

/** @type {(args: object) => Promise<any>} */
let runner = runForgeSkillModel;

/**
 * @param {((args: object) => Promise<any>)|null} next
 * @returns {void}
 */
export function registerSkillModel(next) {
  runner = typeof next === 'function' ? next : runForgeSkillModel;
}

/**
 * @returns {void}
 */
export function resetSkillModel() {
  runner = runForgeSkillModel;
}

/**
 * @returns {boolean}
 */
export function hasSkillModel() {
  return runner === runForgeSkillModel;
}

/**
 * @param {object} args
 * @returns {Promise<any>}
 */
export async function runSkillModel(args) {
  return runner(args);
}
