// How the Cloud Run API (index.js) reaches the agents, set by AGENTS_AT:
//   unset        in this process (runAgent), as before Agent Runtime
//   "runtime"    the Agent Runtime instance AGENT_RUNTIME, through Agent Platform's
//                reasoningEngines streamQuery / query APIs with this service's identity
//   http(s) URL  a runtime.js running elsewhere (local development of the runtime contract)
import { GoogleAuth } from "google-auth-library";
import { runtime } from "./platform.js";

export const AGENTS_AT = process.env.AGENTS_AT || "";
const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });

function endpoint(stream) {
  if (AGENTS_AT === "runtime") {
    if (!runtime) throw new Error("AGENTS_AT=runtime needs AGENT_RUNTIME");
    return `https://${runtime.location}-aiplatform.googleapis.com/v1/${runtime.name}:${stream ? "streamQuery" : "query"}`;
  }
  return `${AGENTS_AT.replace(/\/$/, "")}/api/${stream ? "stream_reasoning_engine" : "reasoning_engine"}`;
}

async function post(stream, body, signal) {
  const headers = { "Content-Type": "application/json" };
  if (AGENTS_AT === "runtime") headers.Authorization = `Bearer ${await auth.getAccessToken()}`;
  const res = await fetch(endpoint(stream), { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!res.ok) throw Object.assign(new Error(`Agents answered ${res.status}: ${(await res.text()).slice(0, 300)}`), { status: res.status });
  return res;
}

/** One unary class method (query, list_memories, delete_memory); returns its output. */
export async function callAgents(method, input) {
  const data = await (await post(false, { class_method: method, input })).json();
  return data.output;
}

/** Streams a chat turn's events ({ type: "step" | "done" | "error", … }) as they arrive. */
export async function* streamTurn(input, signal) {
  const res = await post(true, { class_method: "stream_query", input }, signal);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}
