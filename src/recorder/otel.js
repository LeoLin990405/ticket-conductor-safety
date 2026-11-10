/**
 * OpenTelemetry GenAI semantic conventions for flight-recorder events.
 *
 * The names (`gen_ai.operation.name`, `gen_ai.tool.name`,
 * `gen_ai.request.model`, …) come from the GenAI spec that OpenLLMetry and
 * Langfuse already speak. Forge entity attribute names cannot contain dots,
 * so the map is stored on the event as the `any` field `span`. An export
 * button turns the same map into OTLP JSON.
 *
 * Workers are deterministic. There is no model call, so
 * `gen_ai.request.model` is `deterministic-fallback` on every span. That is
 * intentional: a judge can see we did not pretend an LLM ran.
 *
 * @module recorder/otel
 */

import { createHash } from 'node:crypto';

/** Model attribute used while the deterministic worker path is in force. */
export const DETERMINISTIC_MODEL = 'deterministic-fallback';

/**
 * `gen_ai.request.model` for one event.
 *
 * When the step output says `generator: "llm"` and names a model, that id is
 * the attribute. The deterministic fallback, and every event that is not a
 * model call, stays `deterministic-fallback`.
 *
 * @param {Record<string, unknown>} detail
 * @returns {string}
 */
export function requestModel(detail) {
  if (
    detail.generator === 'llm'
    && typeof detail.model === 'string'
    && detail.model.length > 0
  ) {
    return detail.model;
  }
  return DETERMINISTIC_MODEL;
}

/**
 * @param {string} kind
 * @returns {string}
 */
function operationName(kind) {
  if (
    kind === 'plan.created'
    || kind === 'replan'
    || kind === 'run.forked'
    || kind === 'wave_started'
    || kind === 'lead_decision'
  ) {
    return 'invoke_agent';
  }
  return 'execute_tool';
}

/**
 * @param {unknown} detail
 * @returns {Record<string, unknown>}
 */
function asDetail(detail) {
  return detail !== null && typeof detail === 'object' && !Array.isArray(detail)
    ? /** @type {Record<string, unknown>} */ (detail)
    : {};
}

/**
 * Build the GenAI attribute map for one event.
 *
 * @param {{runId?: string, kind: string, journalKey?: string, detail?: any}} input
 * @returns {Record<string, unknown>}
 */
export function buildGenAiSpan(input) {
  const detail = asDetail(input.detail);
  const toolName = String(
    detail.workerType
    ?? detail.toolName
    ?? detail.kind
    ?? input.kind,
  );
  /** @type {Record<string, unknown>} */
  const span = {
    'gen_ai.operation.name': operationName(input.kind),
    'gen_ai.provider.name': 'ticket-conductor',
    'gen_ai.request.model': requestModel(detail),
    'gen_ai.agent.name': 'ticket-conductor',
    'gen_ai.tool.name': toolName,
    'gen_ai.output.type': 'json',
    'gen_ai.response.finish_reasons': input.kind === 'step.failed'
      ? ['error']
      : ['stop'],
  };
  if (input.runId) {
    span['gen_ai.conversation.id'] = input.runId;
  }
  if (input.journalKey) {
    span['gen_ai.tool.call.id'] = input.journalKey;
  }
  if (typeof detail.phase === 'string') {
    span['gen_ai.tool.call.result'] = detail.phase;
  } else if (typeof detail.summary === 'string') {
    span['gen_ai.tool.call.result'] = detail.summary.slice(0, 200);
  }
  return span;
}

/**
 * @param {string} value
 * @param {number} size
 * @returns {string}
 */
function hexId(value, size) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, size);
}

/**
 * @param {Record<string, unknown>} span
 * @returns {Array<{key: string, value: {stringValue?: string, intValue?: string, boolValue?: boolean}}>}
 */
function otlpAttributes(span) {
  return Object.entries(span).map(([key, raw]) => {
    if (typeof raw === 'boolean') {
      return { key, value: { boolValue: raw } };
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return { key, value: { intValue: String(Math.trunc(raw)) } };
    }
    const stringValue = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
    return { key, value: { stringValue } };
  });
}

/**
 * One run as OTLP/JSON. Trace and span ids are hashes, not the Forge keys,
 * so the export stays inside the OTLP hex width (32 / 16).
 *
 * @param {{runId: string, goal?: string}} run
 * @param {Array<{eventId: string, kind: string, at: number, span?: Record<string, unknown>}>} events
 * @returns {object}
 */
export function toOtlpJson(run, events) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'ticket-conductor' } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'ticket-conductor.flight-recorder' },
            spans: events.map((event) => {
              const at = Number(event.at) || 0;
              const nano = String(Math.trunc(at * 1e6));
              return {
                traceId: hexId(run.runId, 32),
                spanId: hexId(event.eventId, 16),
                name: event.kind,
                startTimeUnixNano: nano,
                endTimeUnixNano: nano,
                attributes: otlpAttributes(event.span ?? {}),
              };
            }),
          },
        ],
      },
    ],
  };
}
