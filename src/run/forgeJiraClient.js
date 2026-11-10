/**
 * Lazy production Jira client for the built-in WP3 workers.
 *
 * The workers only need two read operations for the MVP:
 * - a JQL search (the `research` worker), and
 * - the linked issues of one issue (the `check-deps` worker).
 *
 * Both use `api.asApp().requestJira(...)`. Step workers run in an async consumer
 * with no end-user context, so `asApp` is correct; the app requests
 * `read:jira-work` in the manifest (WP9). Nothing here writes to Jira: writes
 * go through the WP2 effects queue.
 *
 * `@forge/api` is imported lazily so unit tests never load the Forge runtime.
 *
 * @module run/forgeJiraClient
 */

/** Cached client so the dynamic import and app API lookup happen once. @type {object|null} */
let cachedClient = null;

/**
 * Convert one raw Jira search issue into the small shape workers use.
 *
 * @param {any} issue
 * @returns {{key: string, summary: string, status: string, issueType: string}}
 */
function simplifyIssue(issue) {
  const fields = issue?.fields ?? {};
  return {
    key: String(issue?.key ?? ''),
    summary: String(fields.summary ?? ''),
    status: String(fields.status?.name ?? ''),
    issueType: String(fields.issuetype?.name ?? ''),
  };
}

/**
 * Flatten the inward/outward link arrays returned by the issue REST endpoint.
 *
 * @param {any} issue
 * @returns {Array<{key: string, summary: string, status: string, type: string, direction: string}>}
 */
function simplifyLinks(issue) {
  const links = Array.isArray(issue?.fields?.issuelinks)
    ? issue.fields.issuelinks
    : [];
  const result = [];
  for (const link of links) {
    const type = String(link?.type?.name ?? '');
    if (link?.inwardIssue) {
      result.push({
        key: String(link.inwardIssue.key ?? ''),
        summary: String(link.inwardIssue.fields?.summary ?? ''),
        status: String(link.inwardIssue.fields?.status?.name ?? ''),
        type: String(link.type?.inward ?? type),
        direction: 'inward',
      });
    }
    if (link?.outwardIssue) {
      result.push({
        key: String(link.outwardIssue.key ?? ''),
        summary: String(link.outwardIssue.fields?.summary ?? ''),
        status: String(link.outwardIssue.fields?.status?.name ?? ''),
        type: String(link.type?.outward ?? type),
        direction: 'outward',
      });
    }
  }
  return result;
}

/**
 * @param {Response} response
 * @param {string} operation
 * @returns {Promise<any>}
 */
async function readJson(response, operation) {
  if (!response.ok) {
    let detail = '';
    try {
      detail = await response.text();
    } catch {
      detail = '<no response body>';
    }
    throw new Error(
      `Jira ${operation} failed with HTTP ${response.status}: ${detail.slice(0, 500)}`,
    );
  }
  return response.json();
}

/**
 * Create (and memoise) the Forge-backed Jira client.
 *
 * @returns {Promise<{searchIssues: Function, getIssueLinks: Function}>}
 */
export async function getForgeJiraClient() {
  if (cachedClient) {
    return cachedClient;
  }

  const forgeApi = await import('@forge/api');
  const api = forgeApi.default;
  // Paths are built here with encodeURIComponent on every dynamic part.
  // route`${url}` would escape the whole path and Forge rejects it as
  // "path manipulation", so mark the prebuilt path as trusted instead.
  const { assumeTrustedRoute } = forgeApi;

  /**
   * Run a JQL search with the new `/search/jql` endpoint.
   *
   * @param {string} jql
   * @param {{limit?: number}} [options]
   * @returns {Promise<Array<{key: string, summary: string, status: string, issueType: string}>>}
   */
  async function searchIssues(jql, options = {}) {
    if (typeof jql !== 'string' || jql.trim().length === 0) {
      throw new TypeError('searchIssues needs a non-empty JQL string');
    }
    const limit = Number.isInteger(options.limit) ? options.limit : 10;
    const url =
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}` +
      `&maxResults=${limit}&fields=summary,status,issuetype`;
    const response = await api.asApp().requestJira(assumeTrustedRoute(url), {
      headers: { Accept: 'application/json' },
    });
    const data = await readJson(response, 'JQL search');
    return (Array.isArray(data?.issues) ? data.issues : []).map(simplifyIssue);
  }

  /**
   * Read the links of one issue. `check-deps` uses this to surface blockers.
   *
   * @param {string} issueKey
   * @returns {Promise<Array<{key: string, summary: string, status: string, type: string, direction: string}>>}
   */
  async function getIssueLinks(issueKey) {
    if (typeof issueKey !== 'string' || issueKey.length === 0) {
      throw new TypeError('getIssueLinks needs an issue key');
    }
    const url = `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=issuelinks`;
    const response = await api.asApp().requestJira(assumeTrustedRoute(url), {
      headers: { Accept: 'application/json' },
    });
    const data = await readJson(response, 'issue links');
    return simplifyLinks(data);
  }

  cachedClient = { searchIssues, getIssueLinks };
  return cachedClient;
}

/**
 * Reset the memoised client. Only used by tests that mock `@forge/api`.
 *
 * @returns {void}
 */
export function resetForgeJiraClient() {
  cachedClient = null;
}
