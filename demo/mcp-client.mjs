#!/usr/bin/env node
/**
 * Demo client: another agent hands a goal to Ticket Conductor and reads
 * the status back.
 *
 * Two modes, neither of which deploys or installs the app:
 *
 *   node demo/mcp-client.mjs --print
 *     Print the MCP endpoint, a Cursor config, and the JSON-RPC calls a
 *     client sends. No network.
 *
 *   node demo/mcp-client.mjs --local --epic PAY-1 --project PAY --goal "..."
 *     Run the same four handlers the actions call, against the in-memory
 *     store. Queues are stubbed, so no Jira issue is created. This is the
 *     path the unit test executes.
 *
 * This process never posts to Atlassian. Cursor and Claude are the live
 * clients: they open the OAuth screen themselves. A live call also needs
 * the app installed on a development site and a site admin enabling these
 * tools for external clients (they are off by default). `--live` only
 * explains that and exits. It does not send a token and it does not
 * accept a production site.
 *
 * Tool names in the JSON-RPC body are the action keys (`plan-split`, ...).
 * `tools/list` on a connected client is the check that Atlassian publishes
 * those keys unchanged. That response has not been captured yet.
 *
 * @module demo/mcp-client
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { handoffGoal, defaultStepsJson } from '../src/actions/handoff.js';
import { REUSABLE_TOOL_KEYS } from '../src/actions/contract.js';
import { createMemoryStore, setStore } from '../src/store/index.js';

/** Product app id. The UUID is the `<appId>` in the MCP URL. */
const APP_ARI_PATTERN = /ari:cloud:ecosystem::app\/([0-9a-f-]{36})/;

/**
 * Read the UUID out of manifest.yml so the printed URL cannot drift from
 * the app id that is actually shipped.
 *
 * @param {string} manifestYaml
 * @returns {string}
 */
export function appIdFromManifest(manifestYaml) {
  const match = APP_ARI_PATTERN.exec(manifestYaml);
  if (!match) {
    throw new Error('manifest.yml has no app id');
  }
  return match[1];
}

/**
 * Endpoint documented for one Forge app's `rovo:mcp` module.
 * External exposure is a separate admin switch. The URL existing in this
 * string does not mean the switch is on.
 *
 * @param {string} appId UUID, not the full ARI.
 * @returns {string}
 */
export function mcpEndpoint(appId) {
  return `https://mcp.atlassian.com/forge/${appId}`;
}

/**
 * One JSON-RPC 2.0 request. Streamable HTTP clients POST this document
 * with `Accept: application/json, text/event-stream`.
 *
 * @param {string} method
 * @param {object} params
 * @param {number} id
 */
export function buildJsonRpc(method, params, id) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params,
  };
}

/**
 * The four calls, in the order `handoffGoal` runs them.
 * `dispatch-run` and `get-run-status` cannot know `runId` until
 * `plan-split` returns, so the printed calls use the placeholder
 * `{{plan-split.runId}}`. `--local` fills the real id.
 *
 * @param {{epicKey: string, projectKey: string, goal: string, stepsJson: string}} input
 * @returns {Array<{name: string, arguments: Record<string, unknown>}>}
 */
export function plannedToolCalls(input) {
  return [
    {
      name: 'recall-memory',
      arguments: { projectKey: input.projectKey, query: input.goal },
    },
    {
      name: 'plan-split',
      arguments: {
        epicKey: input.epicKey,
        projectKey: input.projectKey,
        goal: input.goal,
        stepsJson: input.stepsJson,
      },
    },
    {
      name: 'dispatch-run',
      arguments: { runId: '{{plan-split.runId}}' },
    },
    {
      name: 'get-run-status',
      arguments: { runId: '{{plan-split.runId}}' },
    },
  ];
}

/**
 * Cursor's MCP config for this app. OAuth is the client's job. No token
 * belongs in this file.
 *
 * @param {string} endpoint
 */
export function cursorMcpConfig(endpoint) {
  return {
    mcpServers: {
      'ticket-conductor': {
        url: endpoint,
      },
    },
  };
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const args = { print: false, local: false, live: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--print') args.print = true;
    else if (token === '--local') args.local = true;
    else if (token === '--live') args.live = true;
    else if (token === '--epic') args.epic = argv[++index];
    else if (token === '--project') args.project = argv[++index];
    else if (token === '--goal') args.goal = argv[++index];
    else if (token === '--steps-json') args.stepsJson = argv[++index];
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Unknown argument ${token}`);
  }
  return args;
}

/**
 * Run the four handlers in-process. The memory store replaces the Forge
 * entity store. The queue stubs replace `@forge/events`, so this function
 * is safe outside the Forge runtime and does not write to Jira.
 *
 * @param {{epicKey: string, projectKey: string, goal: string, stepsJson?: string}} input
 */
export async function runLocalHandoff(input) {
  const store = createMemoryStore({ now: () => 1_700_000_000_000 });
  setStore(store);
  const stepsJson = input.stepsJson || defaultStepsJson(input.goal);
  const overrides = {
    store,
    enqueueEffect: async () => ({ requestKey: 'local-demo', created: true }),
    enqueueStep: async () => ({ jobId: 'local-demo' }),
  };
  return handoffGoal(
    {
      epicKey: input.epicKey,
      projectKey: input.projectKey,
      goal: input.goal,
      stepsJson,
    },
    { principal: { accountId: 'mcp-local-demo' } },
    overrides,
  );
}

/**
 * @param {string[]} argv
 */
export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || (!args.print && !args.local && !args.live)) {
    console.error(
      'Usage: node demo/mcp-client.mjs --print\n'
      + '       node demo/mcp-client.mjs --local --epic PAY-1 --project PAY --goal "Ship refunds"',
    );
    return args.help ? 0 : 2;
  }

  const manifest = readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8');
  const appId = appIdFromManifest(manifest);
  const endpoint = mcpEndpoint(appId);
  const sample = {
    epicKey: String(args.epic || 'PAY-1'),
    projectKey: String(args.project || 'PAY'),
    goal: String(args.goal || 'Ship payment refunds'),
    stepsJson: String(args.stepsJson || defaultStepsJson(String(args.goal || 'Ship payment refunds'))),
  };

  if (args.print) {
    const calls = plannedToolCalls(sample).map((call, index) => (
      buildJsonRpc('tools/call', call, index + 1)
    ));
    console.log(JSON.stringify({
      endpoint,
      transport: 'http',
      note: 'External tools are off until a site admin enables them. Cursor completes OAuth. This printout sends nothing.',
      tools: REUSABLE_TOOL_KEYS,
      cursor: cursorMcpConfig(endpoint),
      claudeCode: `claude mcp add --transport http ticket-conductor ${endpoint}`,
      requests: calls,
    }, null, 2));
  }

  if (args.local) {
    if (!args.epic || !args.goal) {
      throw new Error('--local requires --epic and --goal');
    }
    const result = await runLocalHandoff({
      epicKey: String(args.epic),
      projectKey: String(args.project || String(args.epic).split('-')[0]),
      goal: String(args.goal),
      stepsJson: typeof args.stepsJson === 'string' ? args.stepsJson : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (args.live) {
    // Deliberately no fetch. The OAuth browser flow belongs to Cursor or
    // Claude. Printing the endpoint is the whole of this branch.
    console.error(
      `This script does not call ${endpoint}. Add demo/cursor-mcp.json to the client and complete OAuth there. External tools stay off until a site admin enables them. Do not enable them on a production site.`,
    );
    return 2;
  }

  return 0;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
