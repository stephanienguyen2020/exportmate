// Structured logs. On Cloud Run (K_SERVICE is set) each line is JSON, which Cloud
// Logging parses into severity, message and searchable fields, grouped by trace.
// Locally lines are plain text. Never log tokens, question text or file contents.
//
// One chat, one trace: the Cloud Run API passes its request's trace to the agents on Agent Runtime
// (index.js sends `traceparentFrom`, runtime.js runs the turn `inRequestTrace`), so ADK's spans (invocation, agents,
// model calls, tools) and the agents' log lines land in the same Cloud Trace as the web request.
import { context, isSpanContextValid, trace as otel, TraceFlags } from "@opentelemetry/api";
import { PROJECT } from "./db.js";

const JSON_LINES = Boolean(process.env.K_SERVICE);
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const CLOUD_TRACE = /^([0-9a-f]{32})\/(\d{1,20})/i;

/** The trace ID of the active OpenTelemetry context (inside a turn on Agent Runtime), if any. */
const activeTraceId = () => {
  const span = otel.getSpanContext(context.active());
  return span && isSpanContextValid(span) ? span.traceId : "";
};

/**
 * severity: DEBUG | INFO | WARNING | ERROR. `trace` is the X-Cloud-Trace-Context header, if any;
 * without it the line joins the active OpenTelemetry trace.
 */
export function log(severity, message, { trace, ...fields } = {}) {
  if (JSON_LINES) {
    const traceId = typeof trace === "string" ? trace.split("/")[0] : activeTraceId();
    const line = { severity, message, ...fields };
    if (traceId) line["logging.googleapis.com/trace"] = `projects/${PROJECT}/traces/${traceId}`;
    (severity === "ERROR" ? console.error : console.log)(JSON.stringify(line));
    return;
  }
  const extra = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(" ");
  (severity === "ERROR" ? console.error : severity === "WARNING" ? console.warn : console.log)(`${message}${extra ? ` ${extra}` : ""}`);
}

/**
 * A request's W3C traceparent for the agents: from X-Cloud-Trace-Context ("TRACE/SPAN;o=1", span in
 * decimal, the trace this service's logs use), else from a traceparent header. Always marked sampled,
 * so the agents keep their spans whatever the load balancer decided.
 */
export function traceparentFrom(headers = {}) {
  const cloud = CLOUD_TRACE.exec(headers["x-cloud-trace-context"] || "");
  const w3c = TRACEPARENT.exec(String(headers.traceparent || "").toLowerCase());
  const traceId = cloud ? cloud[1].toLowerCase() : w3c?.[1];
  const spanId = cloud ? (BigInt(cloud[2]) & 0xffffffffffffffffn).toString(16).padStart(16, "0") : w3c?.[2];
  const parent = traceId && { traceId, spanId, traceFlags: TraceFlags.SAMPLED };
  return parent && isSpanContextValid(parent) ? `00-${traceId}-${spanId}-01` : undefined;
}

/** Runs `fn` as part of the trace a traceparent names (index.js's request), or as before without one. */
export function inRequestTrace(traceparent, fn) {
  const m = TRACEPARENT.exec(traceparent || "");
  const parent = m && { traceId: m[1], spanId: m[2], traceFlags: TraceFlags.SAMPLED, isRemote: true };
  if (!parent || !isSpanContextValid(parent)) return fn();
  return context.with(otel.setSpanContext(context.active(), parent), fn);
}
