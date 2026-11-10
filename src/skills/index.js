/**
 * Public entry for the skill library and sub-agent briefs (WP15).
 *
 * Other packages should import from here:
 *
 * ```js
 * import { listSkillIndex, loadSkill, prepareStepDraft } from '../skills/index.js';
 * ```
 *
 * `listSkillIndex` is the Router view (name + description).
 * `loadSkill` is the worker view (the whole pack).
 *
 * @module skills
 */

export { SkillContractError, SkillLibraryError } from './errors.js';
export {
  defaultSkillRoot,
  listSkillIndex,
  listSkillNames,
  loadSkill,
  parseSkillFile,
  setSkillRoot,
  skillRoot,
  tryLoadSkill,
} from './library.js';
export { briefForStep, buildBrief, fallbackBrief, prepareStepDraft } from './brief.js';
export { validateOutput, validateWithOneRepair } from './schema.js';
export { checklistItems, runChecklist } from './procedures.js';
export { hasSkillModel, registerSkillModel, resetSkillModel } from './modelHook.js';
export { renderFullOutput, runSubAgent, toShortResult } from './runSubAgent.js';
