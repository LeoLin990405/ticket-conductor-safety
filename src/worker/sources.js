/**
 * Read-only Jira and Confluence retrieval for the research worker (WP11).
 *
 * Queries come from the plan (step input, or a keyword query built from the
 * goal and title). Issue bodies and page excerpts are never turned into JQL
 * or CQL. They are data for the model, fetched only after the query is fixed.
 *
 * In unit tests the worker's `ctx.jira.searchIssues` stub is used, and
 * Confluence is skipped unless the test passes `ctx.confluence.search`.
 * Inside a Forge function the same module also calls Jira and Confluence
 * with `asApp()`. A step consumer has no end user, so `asUser()` has no
 * account to act as. The calls are reads. Writes stay on the effects queue.
 *
 * Paths are passed to Forge `route` as a real template
 * (`route`/rest/api/3/search/jql?jql=${jql}``), not as one prebuilt string.
 * A prebuilt string is rejected at runtime as path manipulation.
 *
 * @module worker/sources
 */

import { clip, httpsUrl } from './guard.js';
import { runningInForge } from './llm.js';

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/**
 * Escape a value for a JQL or CQL double-quoted string.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeQuoted(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * True when a plan string is already a query, not a sentence.
 *
 * A sentence such as "Search TD for onboarding docs" must not be sent as
 * JQL. Jira answers that with HTTP 400 and the research step gets stuck.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeJql(text) {
  return /^\s*(project|key|issuekey|parent|text|summary|labels|status|assignee|issuetype|type)\s*(=|!=|~|!~|\bin\b|\bnot in\b|\bis\b)/i.test(text);
}

/**
 * Up to six words from the title and the goal, for a quoted text search.
 *
 * Punctuation is removed first, so a URL in the goal becomes words. It is
 * not fetched. The words are then escaped inside one JQL/CQL string.
 *
 * @param {import('../store/types.js').Run} run
 * @param {{title?: string}} step
 * @returns {string[]}
 */
function searchWords(run, step) {
  const words = `${step?.title ?? ''} ${run?.goal ?? ''}`
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 6);
  return words.length > 0 ? words : [String(step?.title ?? 'work')];
}

/**
 * Build a conservative JQL query when the plan did not provide one.
 *
 * @param {import('../store/types.js').Run} run
 * @param {{title?: string}} step
 * @returns {string}
 */
export function defaultResearchJql(run, step) {
  const searchTerm = searchWords(run, step).join(' ');
  return (
    `project = "${escapeQuoted(run.projectKey)}" ` +
    `AND text ~ "${escapeQuoted(searchTerm)}" ` +
    `AND key != "${escapeQuoted(run.epicKey)}" ` +
    'ORDER BY updated DESC'
  );
}

/**
 * Build a CQL page search from the same words as {@link defaultResearchJql}.
 *
 * The plan's JQL string is not reused. JQL is not valid CQL, and a plan
 * string that embeds a URL must not be sent to Confluence unchanged.
 *
 * @param {import('../store/types.js').Run} run
 * @param {{title?: string}} step
 * @returns {string}
 */
export function defaultResearchCql(run, step) {
  const searchTerm = searchWords(run, step).join(' ');
  return `type = page AND text ~ "${escapeQuoted(searchTerm)}" ORDER BY lastmodified DESC`;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function clampLimit(value) {
  if (!Number.isInteger(value)) {
    return 10;
  }
  return Math.min(10, Math.max(1, value));
}

/**
 * The JQL the research worker will run. Plan text only.
 *
 * @param {import('../store/types.js').Step} step
 * @param {{run: import('../store/types.js').Run}} ctx
 * @returns {string}
 */
export function resolveResearchJql(step, ctx) {
  const input = asRecord(step.input);
  if (typeof step.input === 'string') {
    if (looksLikeJql(step.input)) {
      return step.input;
    }
    return defaultResearchJql(ctx.run, { ...step, title: step.input });
  }
  if (typeof input.jql === 'string' && input.jql.length > 0) {
    return input.jql;
  }
  if (typeof input.query === 'string' && input.query.length > 0) {
    return input.query;
  }
  return defaultResearchJql(ctx.run, step);
}

/**
 * The CQL the research worker will run, or null when the plan opts out.
 *
 * @param {import('../store/types.js').Step} step
 * @param {{run: import('../store/types.js').Run}} ctx
 * @returns {string|null}
 */
export function resolveResearchCql(step, ctx) {
  const input = asRecord(step.input);
  if (input.confluence === false || input.cql === false) {
    return null;
  }
  if (typeof input.cql === 'string' && input.cql.trim().length > 0) {
    return input.cql.trim();
  }
  return defaultResearchCql(ctx.run, step);
}

/**
 * Flatten an ADF node to plain text. Descriptions are data, not markup we run.
 *
 * @param {unknown} node
 * @param {number} [max]
 * @returns {string}
 */
export function adfToText(node, max = 500) {
  /** @type {string[]} */
  const parts = [];
  /**
   * @param {unknown} value
   */
  function walk(value) {
    if (parts.join(' ').length >= max || value === null || value === undefined) {
      return;
    }
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walk(child);
      }
      return;
    }
    if (typeof value === 'object') {
      const record = /** @type {Record<string, unknown>} */ (value);
      if (typeof record.text === 'string') {
        parts.push(record.text);
      }
      if (Array.isArray(record.content)) {
        walk(record.content);
      }
    }
  }
  walk(node);
  return clip(parts.join(' '), max);
}

/**
 * @param {string} excerpt
 * @returns {string}
 */
function cleanExcerpt(excerpt) {
  return String(excerpt ?? '')
    .replace(/@@@hl@@@|@@@endhl@@@/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

/**
 * `https://site.atlassian.net/browse/KEY` from a Jira `self` URL.
 *
 * @param {unknown} self
 * @param {string} key
 * @returns {string}
 */
export function browseUrlFromSelf(self, key) {
  if (typeof self !== 'string' || !key) {
    return '';
  }
  const match = /^(https:\/\/[^/]+)\/rest\/api\/3\/issue\//.exec(self);
  if (!match) {
    return '';
  }
  return httpsUrl(`${match[1]}/browse/${encodeURIComponent(key)}`);
}

/**
 * Normalise a Jira search payload or a test stub.
 *
 * @param {any} result
 * @returns {Array<Record<string, any>>}
 */
export function normalizeIssues(result) {
  const raw = Array.isArray(result)
    ? result
    : Array.isArray(result?.issues)
      ? result.issues
      : [];
  return raw.map((issue) => {
    if (issue && typeof issue === 'object' && 'summary' in issue && !issue.fields) {
      const key = String(issue.key ?? '');
      return {
        key,
        summary: String(issue.summary ?? ''),
        status: String(issue.status ?? ''),
        issueType: String(issue.issueType ?? ''),
        excerpt: clip(cleanExcerpt(issue.excerpt ?? issue.description ?? ''), 500),
        url: httpsUrl(issue.url) || browseUrlFromSelf(issue.self, key),
      };
    }
    const fields = asRecord(issue?.fields);
    const key = String(issue?.key ?? '');
    return {
      key,
      summary: String(fields.summary ?? ''),
      status: String(asRecord(fields.status).name ?? ''),
      issueType: String(asRecord(fields.issuetype).name ?? ''),
      excerpt: adfToText(fields.description, 500),
      url: browseUrlFromSelf(issue?.self, key),
    };
  }).filter((issue) => issue.key.length > 0);
}

/**
 * Normalise a Confluence CQL search payload or a test stub.
 *
 * @param {any} result
 * @returns {Array<Record<string, any>>}
 */
export function normalizePages(result) {
  const raw = Array.isArray(result)
    ? result
    : Array.isArray(result?.results)
      ? result.results
      : Array.isArray(result?.pages)
        ? result.pages
        : [];
  const base = typeof result?._links?.base === 'string' ? result._links.base : '';
  return raw.map((page) => {
    const content = asRecord(page?.content);
    const id = String(page?.id ?? content.id ?? '');
    const relative = typeof page?.url === 'string' ? page.url : '';
    let url = httpsUrl(relative);
    if (!url && relative.startsWith('/') && base.startsWith('https://')) {
      url = httpsUrl(`${base.replace(/\/$/, '')}${relative}`);
    }
    return {
      id,
      title: String(page?.title ?? content.title ?? ''),
      excerpt: clip(cleanExcerpt(page?.excerpt ?? page?.excerptText ?? ''), 500),
      url,
      spaceKey: String(
        page?.spaceKey ??
          asRecord(page?.resultGlobalContainer).title ??
          '',
      ),
    };
  }).filter((page) => page.id.length > 0 || page.title.length > 0);
}

/**
 * Normalise linked-issue results from a Jira client or a test stub.
 *
 * @param {any} result
 * @returns {Array<Record<string, any>>}
 */
export function normalizeLinks(result) {
  const raw = Array.isArray(result)
    ? result
    : Array.isArray(result?.links)
      ? result.links
      : [];
  return raw.map((link) => ({
    key: String(link.key ?? ''),
    summary: String(link.summary ?? ''),
    status: String(link.status ?? ''),
    type: String(link.type ?? ''),
    direction: String(link.direction ?? ''),
  })).filter((link) => link.key.length > 0);
}

/**
 * @param {any} ctx
 * @returns {Promise<boolean>}
 */
async function useForgeRetrieval(ctx) {
  if (ctx?.useForgeRetrieval === false) {
    return false;
  }
  if (ctx?.useForgeRetrieval === true) {
    return true;
  }
  return runningInForge();
}

/**
 * @param {Response|object} response
 * @param {string} operation
 * @returns {Promise<any>}
 */
async function readJson(response, operation) {
  if (response && response.ok === false) {
    let detail = '';
    try {
      detail = typeof response.text === 'function' ? await response.text() : '';
    } catch {
      detail = '';
    }
    throw new Error(
      `${operation} failed with HTTP ${response.status}: ${String(detail).slice(0, 180)}`,
    );
  }
  if (response && typeof response.json === 'function') {
    return response.json();
  }
  return response;
}

/**
 * Richer Jira search used inside Forge. Includes the description excerpt and
 * the browse URL. The product client in `src/run` stays unchanged so this
 * package does not collide with other work.
 *
 * @param {string} jql
 * @param {number} limit
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function searchJiraWithForge(jql, limit) {
  const forgeApi = await import('@forge/api');
  const api = forgeApi.default;
  const { route } = forgeApi;
  const maxResults = String(limit);
  const response = await api.asApp().requestJira(
    route`/rest/api/3/search/jql?jql=${jql}&maxResults=${maxResults}&fields=summary,status,issuetype,description`,
    { headers: { Accept: 'application/json' } },
  );
  const data = await readJson(response, 'Jira JQL search');
  return normalizeIssues(data);
}

/**
 * CQL search. `search:confluence` is the classic scope for this endpoint.
 * The request does not expand page bodies, so it does not need
 * `read:confluence-content.all`.
 *
 * @param {string} cql
 * @param {number} limit
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function searchConfluenceWithForge(cql, limit) {
  const forgeApi = await import('@forge/api');
  const api = forgeApi.default;
  const { route } = forgeApi;
  const max = String(Math.min(limit, 5));
  const response = await api.asApp().requestConfluence(
    route`/wiki/rest/api/search?cql=${cql}&limit=${max}`,
    { headers: { Accept: 'application/json' } },
  );
  const data = await readJson(response, 'Confluence CQL search');
  return normalizePages(data);
}

/**
 * @param {any} ctx
 * @param {string} message
 */
function warn(ctx, message) {
  if (typeof ctx?.logger?.warn === 'function') {
    ctx.logger.warn(message);
  }
}

/**
 * Issues for one research step.
 *
 * @param {any} ctx
 * @param {string} jql
 * @param {number} limit
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function loadIssues(ctx, jql, limit) {
  if (await useForgeRetrieval(ctx)) {
    try {
      return await searchJiraWithForge(jql, limit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(ctx, `WP11 rich Jira search failed, using the worker client: ${message.slice(0, 180)}`);
    }
  }
  if (typeof ctx?.jira?.searchIssues !== 'function') {
    throw new TypeError('research needs ctx.jira.searchIssues');
  }
  return normalizeIssues(await ctx.jira.searchIssues(jql, { limit }));
}

/**
 * Pages for one research step. A missing Confluence client is an empty list,
 * not a failed step: Jira findings still stand.
 *
 * @param {any} ctx
 * @param {string|null} cql
 * @param {number} limit
 * @returns {Promise<{pages: Array<Record<string, any>>, confluence: string}>}
 */
async function loadPages(ctx, cql, limit) {
  if (!cql) {
    return { pages: [], confluence: 'skipped' };
  }
  if (typeof ctx?.confluence?.search === 'function') {
    try {
      return {
        pages: normalizePages(await ctx.confluence.search(cql, { limit })),
        confluence: 'client',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(ctx, `WP11 Confluence client search failed: ${message.slice(0, 180)}`);
      return { pages: [], confluence: 'error' };
    }
  }
  if (await useForgeRetrieval(ctx)) {
    try {
      return {
        pages: await searchConfluenceWithForge(cql, limit),
        confluence: 'forge',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(ctx, `WP11 Confluence search failed: ${message.slice(0, 180)}`);
      return { pages: [], confluence: 'error' };
    }
  }
  return { pages: [], confluence: 'skipped' };
}

/**
 * Run the plan's JQL and CQL. The returned records are the only sources the
 * model is allowed to cite.
 *
 * @param {import('../store/types.js').Step} step
 * @param {any} ctx
 * @returns {Promise<{jql: string, cql: string|null, limit: number, issues: Array<Record<string, any>>, pages: Array<Record<string, any>>, confluence: string}>}
 */
export async function gatherResearch(step, ctx) {
  const input = asRecord(step.input);
  const jql = resolveResearchJql(step, ctx);
  const cql = resolveResearchCql(step, ctx);
  const limit = clampLimit(input.limit);
  const issues = await loadIssues(ctx, jql, limit);
  const { pages, confluence } = await loadPages(ctx, cql, limit);
  return { jql, cql, limit, issues, pages, confluence };
}

/**
 * Earlier steps whose output a draft or summary may read.
 *
 * `dependsOn` is optional. WP10 owns the scheduler. When the field is absent
 * this returns completed steps with a lower `idx`. A parallel run may see
 * none of them yet; the draft then uses the goal and the step input only.
 *
 * @param {import('../store/types.js').Step} step
 * @param {any} ctx
 * @returns {Promise<Array<import('../store/types.js').Step>>}
 */
export async function loadUpstream(step, ctx) {
  if (typeof ctx?.store?.listSteps !== 'function') {
    return [];
  }
  let steps = [];
  try {
    steps = await ctx.store.listSteps(step.runId);
  } catch {
    return [];
  }
  if (!Array.isArray(steps)) {
    return [];
  }
  const explicit = step.dependsOn ?? asRecord(step.input).dependsOn;
  if (Array.isArray(explicit) && explicit.length > 0) {
    const wanted = new Set(explicit.map((value) => String(value)));
    return presentUpstream(step, steps.filter(
      (candidate) =>
        candidate.stepId !== step.stepId &&
        (wanted.has(candidate.stepId) || wanted.has(String(candidate.idx))),
    ));
  }
  return presentUpstream(step, steps.filter(
    (candidate) =>
      candidate.stepId !== step.stepId &&
      candidate.status === 'done' &&
      typeof candidate.idx === 'number' &&
      typeof step.idx === 'number' &&
      candidate.idx < step.idx,
  ));
}

/**
 * Later waves read the digest stored on the step, not the upstream output.
 * Wave 1 still receives the real output. That is the plan graph the
 * existing steps already share.
 *
 * @param {import('../store/types.js').Step} step
 * @param {Array<import('../store/types.js').Step>} upstream
 * @returns {Array<import('../store/types.js').Step>}
 */
function presentUpstream(step, upstream) {
  const digest = asRecord(step?.input).waveDigest;
  const wave = Number.isInteger(step?.wave) && step.wave > 0 ? step.wave : 1;
  if (wave <= 1 || typeof digest !== 'string' || digest.length === 0) {
    return upstream;
  }
  return upstream.map((prior, index) => ({
    ...prior,
    output: index === 0
      ? { summary: digest, digest: true }
      : { summary: `${prior.title} is included in the wave digest`, digest: true },
  }));
}
