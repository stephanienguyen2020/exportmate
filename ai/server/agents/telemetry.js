// Traces of the agents' runs (ADK's invocation, agent, model and tool spans) for Agent Platform:
// the Traces tab of the Agent Runtime instance and Cloud Trace. Spans go to the Telemetry API
// (OTLP over HTTP) with the instance's identity, tagged with the same resource attributes
// Agent Platform's own ADK template uses, so the console finds them by the instance's name.
// Only on Agent Runtime (runtime.js) and only with AGENT_RUNTIME set; GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY=false
// turns it off. Spans carry agent, model and tool names, timings and token counts, never the
// prompts, tool arguments or results (ADK records them unless ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS
// is false): questions and company data stay in the audit trail, as with log.js.
import { randomUUID } from "node:crypto";
import { maybeSetOtelProviders } from "@google/adk";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { GoogleAuth } from "google-auth-library";
import { PROJECT } from "../db.js";
import { runtime } from "./platform.js";

const ENDPOINT = "https://telemetry.googleapis.com/v1/traces";

/** The OpenTelemetry resource attributes Agent Platform files an instance's traces under. */
export function traceResource({ project, location, id }) {
  return {
    "gcp.project_id": project,
    "cloud.account.id": project,
    "cloud.provider": "gcp",
    "cloud.platform": "gcp.agent_engine",
    "cloud.region": location,
    "cloud.resource_id": `//aiplatform.googleapis.com/projects/${project}/locations/${location}/reasoningEngines/${id}`,
    "service.name": id,
    "service.instance.id": `${randomUUID().replaceAll("-", "")}-${process.pid}`,
  };
}

export function startTracing() {
  if (!runtime || process.env.GOOGLE_CLOUD_AGENT_ENGINE_ENABLE_TELEMETRY === "false") return false;
  process.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS = "false";
  const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
  const exporter = new OTLPTraceExporter({
    url: ENDPOINT,
    headers: async () => ({ Authorization: `Bearer ${await auth.getAccessToken()}`, "x-goog-user-project": PROJECT }),
  });
  // Agent Runtime's GOOGLE_CLOUD_PROJECT is the project number; the trace project is the id.
  maybeSetOtelProviders([{ spanProcessors: [new BatchSpanProcessor(exporter)] }], resourceFromAttributes(traceResource({ ...runtime, project: PROJECT })));
  return true;
}
