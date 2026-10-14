// The assistant as an Agent Platform Agent Runtime container (runtime contract): listens on
// 0.0.0.0:$PORT and serves the class methods declared in platform/runtime.py.
//   POST /api/reasoning_engine          { class_method, input } → { output }
//     query          one chat turn, the final result
//     list_memories  { userKey } → what Memory Bank remembers about that user
//     delete_memory  { userKey, id } → { deleted }
//   POST /api/stream_reasoning_engine   { class_method: "stream_query", input } → NDJSON
//     the same events as /api/chat: { type: "step" | "done" | "error", … }
//
// Only the Cloud Run API (index.js) and people with Agent Platform access can call it (IAM on
// the reasoning engine); it trusts the caller's company, user and access, which index.js
// checked with the backend. The user's backend token arrives per call, is used only for the
// company's orders and playbook, and is never stored in the session or logged.
// The console playground sends { message, user_id, session_id }; that runs as the demo.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { runAgent } from "./agent.js";
import { ANONYMOUS, publicAudit, publicStep } from "./access.js";
import { deleteMemory, listMemories } from "./agents/platform.js";
import { startTracing } from "./agents/telemetry.js";
import { readJson } from "./limits.js";
import { log } from "./log.js";

const PORT = Number(process.env.PORT || 8080);
const BACKEND_URL = (process.env.BACKEND_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const SESSION = /^[A-Za-z0-9-]{8,64}$/;

// GETs a backend path with the user's own token ({ status, body }), as index.js does.
const backendReader = (token) => async (path) => {
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000), redirect: "error" });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch (e) {
    return { status: 0, body: {}, reason: e.name };
  }
};

/** A chat turn's arguments from a query input (index.js's, or the console playground's). */
export function chatInput(input = {}) {
  if (typeof input.message === "string") {
    const sessionId = SESSION.test(input.session_id || "") ? input.session_id : `playground-${randomUUID().slice(0, 8)}`;
    return { messages: [{ role: "user", text: input.message.slice(0, 4000) }], sessionId, access: ANONYMOUS, requestId: randomUUID() };
  }
  if (!Array.isArray(input.messages) || !input.messages.length || !SESSION.test(input.sessionId || "")) throw Object.assign(new Error("Expected messages and a sessionId"), { status: 400 });
  return {
    messages: input.messages,
    sessionId: input.sessionId,
    company: input.company ?? null,
    user: input.user ?? null,
    access: input.access ?? ANONYMOUS,
    demo: input.demo ?? null,
    requestId: input.requestId || randomUUID(),
    backend: input.company && input.backendToken ? backendReader(input.backendToken) : null,
    // The golden set run against this runtime (eval/run.js --engine): no cache, no memories,
    // and the evidence and trace come back with the result.
    ...(input.channel === "eval" ? { channel: "eval", withEvidence: true, tier: input.tier } : {}),
  };
}

const METHODS = {
  async query(input) {
    const turn = chatInput(input);
    const result = await runAgent(turn);
    if (turn.channel === "eval") return { result: { ...publicAudit(result), evidence: result.evidence, trace: result.trace } };
    return { reply: result.answer, citations: result.citations, audit: publicAudit(result), status: result.status };
  },
  async list_memories({ userKey }) {
    return { memories: await listMemories(String(userKey || "")) };
  },
  async delete_memory({ userKey, id }) {
    return { deleted: await deleteMemory(String(userKey || ""), String(id || "")) };
  },
};

async function stream(input, res) {
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" });
  const write = (event) => res.write(JSON.stringify(event) + "\n");
  try {
    const result = await runAgent({ ...chatInput(input), onStep: (step) => write({ type: "step", step: publicStep(step) }) });
    if (result.status === "error") write({ type: "error", error: "The assistant is unavailable right now.", auditId: result.id });
    else write({ type: "done", reply: result.answer, citations: result.citations, audit: publicAudit(result) });
  } catch (e) {
    log("ERROR", "runtime.stream_failed", { error: String(e?.message || e) });
    write({ type: "error", error: e.status === 400 ? e.message : "The assistant is unavailable right now." });
  }
  res.end();
}

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

export const server = http.createServer(async (req, res) => {
  if (req.method === "GET") return send(res, 200, { ok: true });
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return send(res, e.status === 413 ? 413 : 400, { error: e.status === 413 ? "Request body too large" : "Invalid JSON" });
  }
  const { class_method: method, input = {} } = body;
  if (req.url === "/api/stream_reasoning_engine") {
    if (method !== "stream_query") return send(res, 400, { error: `Unknown streaming method ${method}` });
    return stream(input, res);
  }
  if (req.url === "/api/reasoning_engine") {
    if (!Object.hasOwn(METHODS, method)) return send(res, 400, { error: `Unknown method ${method}` });
    try {
      return send(res, 200, { output: await METHODS[method](input) });
    } catch (e) {
      log("ERROR", "runtime.query_failed", { method, error: String(e?.message || e) });
      return send(res, e.status === 400 ? 400 : 500, { error: e.status === 400 ? e.message : "The assistant is unavailable right now." });
    }
  }
  return send(res, 404, { error: "Not found" });
});

if (process.env.SERVE === "runtime" || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  const tracing = startTracing();
  server.listen(PORT, "0.0.0.0", () => log("INFO", `ExportMate agents listening on :${PORT} (Agent Runtime contract)`, { tracing }));
}
