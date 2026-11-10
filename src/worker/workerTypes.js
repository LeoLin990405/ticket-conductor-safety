/**
 * Built-in worker types for Ticket Conductor (WP3 + WP11).
 *
 * Each worker reads Jira (and, for research, Confluence), asks the Forge LLM
 * for a JSON document, and returns structured output plus one comment effect.
 * The model is not given tools and cannot choose the effect. See `LLM.md`.
 *
 * When the LLM is unavailable the same functions return the deterministic
 * text the MVP used, so `node --test` and a site without the `llm` module
 * still finish a run.
 *
 * Effect descriptor shape:
 * ```js
 * { kind: 'comment', payload: { issueKey|childOfStepId, bodyText, bodyAdf }, discriminator }
 * ```
 * `discriminator` is stable across retries. WP2 derives the request key from
 * `(runId, stepId, kind, discriminator)`, not from the comment body.
 *
 * @module worker/workerTypes
 */

export {
  defaultResearchCql,
  defaultResearchJql,
  looksLikeJql,
} from './sources.js';

export {
  composeDeps as checkDepsWorker,
  composeDraft as draftSpecWorker,
  composeResearch as researchWorker,
  composeSummary as summarizeWorker,
} from './content.js';
