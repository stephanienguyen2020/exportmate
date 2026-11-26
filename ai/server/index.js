import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { companySources, list } from "./db.js";
import { runAgent, audits } from "./agent.js";
import { log } from "./log.js";
import { ANONYMOUS, auditVisible, publicAudit, publicStep } from "./access.js";
import { readJson } from "./limits.js";
import { deleteMemory, listMemories, memoryKeepDays, remembers, userKeyFor } from "./agents/platform.js";
import { AGENTS_AT, callAgents, streamTurn } from "./agents/remote.js";
import { demoOrders, demoPlaybook } from "./orders.js";
import { ASSISTANT, SCAN_MODEL } from "./models.js";

const PORT = Number(process.env.PORT || 8080);
const MODELS = { assistant: ASSISTANT.model, scan: SCAN_MODEL };
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "http://127.0.0.1:5173,http://localhost:5173"
).split(",");
const MAX_MESSAGES = 20;
const MAX_CHARS = 4000;
// Company backend (FastAPI) origin, for the signed-in company's profile and role. This service
// never reads its database; it calls the API with the user's own token.
const BACKEND_URL = (process.env.BACKEND_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
// Each chat makes several Gemini calls and the API is public, so chats are capped per client and
// per instance (Cloud Run runs at most 3). Counts live in memory and restart with the instance.
const envCount = (name, fallback) => (/^\d+$/.test(process.env[name] || "") ? Number(process.env[name]) : fallback);
const CHAT_WINDOW_MS = 60 * 60_000;
const CHAT_LIMIT_PER_CLIENT = envCount("CHAT_LIMIT_PER_CLIENT", 40);
const CHAT_LIMIT_PER_INSTANCE = envCount("CHAT_LIMIT_PER_INSTANCE", 200);

// GETs a company backend route with the caller's own token. Returns { status, body }; status 0
// means the backend isn't usable (misconfigured or no answer) and `reason` says why.
// The token is only ever sent to BACKEND_URL and is never logged.
async function backendGet(path, authorization) {
  if (!/^Bearer \S+$/.test(authorization || "")) return { status: 401, body: {} };
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BACKEND_URL);
  if (!local && !BACKEND_URL.startsWith("https://")) return { status: 0, body: {}, reason: "BACKEND_URL is not HTTPS" };
  try {
    const res = await fetch(`${BACKEND_URL}${path}`, {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch (e) {
    return { status: 0, body: {}, reason: e.name };
  }
}

// GET /api/v1/me per token, kept for a minute so reads don't each cost a backend call.
// Keyed by a hash of the token; only successful answers are kept.
const ACCOUNT_TTL_MS = 60_000;
const accountCache = new Map();
async function callerAccount(authorization) {
  if (!/^Bearer \S+$/.test(authorization || "")) return { status: 401, body: {} };
  const key = createHash("sha256").update(authorization).digest("hex");
  const hit = accountCache.get(key);
  if (hit && Date.now() - hit.at < ACCOUNT_TTL_MS) return hit.result;
  const result = await backendGet("/api/v1/me", authorization);
  if (result.status === 200) {
    if (accountCache.size > 1000) accountCache.clear();
    accountCache.set(key, { at: Date.now(), result });
  }
  return result;
}

// A company's news settings, kept briefly per instance: the shared sources it switched off for
// itself, and skipOld false when it switched the age rule off (access.js). As an access.
const settingsCache = new Map();
async function companyAccess(companyId) {
  const hit = settingsCache.get(companyId);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const doc = await companySources.doc(companyId).get();
  const value = {
    companyId,
    disabled: doc.exists && Array.isArray(doc.get("disabled")) ? doc.get("disabled") : [],
    ...(doc.exists && doc.get("skipOld") === false ? { skipOld: false } : {}),
  };
  settingsCache.set(companyId, { at: Date.now(), value });
  return value;
}

// What a reader sees: anonymous (demo) unless a valid company token came with the request.
async function readerAccess(req) {
  if (!req.headers.authorization) return ANONYMOUS;
  const { status, body } = await callerAccount(req.headers.authorization);
  const companyId = status === 200 ? body.data?.company?.id : null;
  return companyId ? companyAccess(companyId) : ANONYMOUS;
}

// The caller's company profile and sites, or null (demo chat, signed out, backend down).
async function companyKnowledge(authorization) {
  if (!/^Bearer \S+$/.test(authorization || "")) return null;
  const { status, body, reason } = await backendGet("/api/v1/company/knowledge", authorization);
  if (status === 200) return body.data;
  log("WARNING", "company_profile.unavailable", { reason: reason || `${status} ${body.error?.code || ""}`.trim() });
  return null;
}

// The caller's address. The website's nginx passes X-Forwarded-For on and Cloud Run appends the
// hops it saw, so the first entry is the visitor unless they sent the header themselves. A caller
// can fake it, through the website or straight to Cloud Run; the per-instance cap still bounds
// what they can spend.
function clientAddress(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}

// Chats accepted on this instance in the last CHAT_WINDOW_MS, oldest first.
const recentChats = [];

// Records the chat and returns null if it may run, otherwise the message for a 429.
function chatLimited(client, now = Date.now()) {
  while (recentChats.length && now - recentChats[0].at >= CHAT_WINDOW_MS) recentChats.shift();
  if (recentChats.length >= CHAT_LIMIT_PER_INSTANCE) return "The assistant is busy. Please try again in a few minutes.";
  if (recentChats.filter((c) => c.client === client).length >= CHAT_LIMIT_PER_CLIENT)
    return "You've reached the limit of questions for this hour. Please try again later.";
  recentChats.push({ client, at: now });
  return null;
}

const SESSION = /^[A-Za-z0-9-]{8,64}$/;

function cors(origin) {
  return origin && ALLOWED_ORIGINS.includes(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
}

function send(res, status, body, origin) {
  res.writeHead(status, { "Content-Type": "application/json", ...cors(origin) });
  res.end(JSON.stringify(body));
}

function parseMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const parsed = messages.slice(-MAX_MESSAGES).map((m) =>
    m && typeof m.text === "string" && ["user", "model"].includes(m.role)
      ? {
          role: m.role,
          text: m.text.slice(0, MAX_CHARS),
          sources: Array.isArray(m.sources) ? m.sources.filter((x) => typeof x === "string").slice(0, 12).map((x) => x.slice(0, 200)) : undefined,
        }
      : null,
  );
  if (parsed.includes(null) || parsed[0].role !== "user" || parsed.at(-1).role !== "user") return null;
  return parsed;
}

// One metrics line per chat for Cloud Logging (latency, tokens, tool errors, auditor result).
// The full trace is the audit document; the question and answer text stay out of logs.
function logChat(result, trace) {
  const tools = result.steps.filter((s) => s.kind === "tool");
  log(result.status === "error" ? "ERROR" : "INFO", "chat.completed", {
    trace,
    requestId: result.requestId,
    auditId: result.id,
    companyId: result.companyId,
    status: result.status,
    policyVersion: result.policyVersion,
    model: result.model,
    tier: result.route?.tier,
    escalated: Boolean(result.route?.escalated),
    cached: Boolean(result.cache),
    latencyMs: result.latencyMs,
    modelCalls: result.usage.modelCalls,
    promptTokens: result.usage.promptTokens,
    outputTokens: result.usage.outputTokens,
    toolCalls: tools.length,
    toolErrors: tools.filter((s) => s.error).map((s) => `${s.name}:${s.errorKind}`),
    revised: result.steps.some((s) => s.kind === "review"),
    checksFailed: result.checks.filter((c) => !c.ok).map((c) => c.name),
    citations: result.citations.length,
    withheld: result.flags?.length || 0,
    // The graph critic (critic.js), when it judged this answer: a slow one shows whether it
    // thought for long, was retried, or gave up at its time limit.
    ...(result.critic && {
      criticMs: result.critic.latencyMs,
      criticThinkingTokens: result.critic.tokens?.thinking,
      criticAttempts: result.critic.attempts || 1,
      criticError: result.critic.error,
    }),
  });
}

// Streams the agent's audit steps as NDJSON, then the final answer and audit record.
async function streamChat(req, res, body, origin, requestId) {
  const messages = parseMessages(body.messages);
  if (!messages) return send(res, 400, { error: "Expected messages ending with a user message" }, origin);
  if (!SESSION.test(body.sessionId || "")) return send(res, 400, { error: "Expected a sessionId" }, origin);
  const trace = req.headers["x-cloud-trace-context"];
  const limited = chatLimited(clientAddress(req));
  if (limited) {
    log("WARNING", "chat.refused", { requestId, trace, reason: limited });
    return send(res, 429, { error: limited }, origin);
  }
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    ...cors(origin),
  });
  const write = (event) => res.write(JSON.stringify(event) + "\n");
  try {
    const company = await companyKnowledge(req.headers.authorization);
    const access = company ? await companyAccess(company.company.id) : ANONYMOUS;
    // The signed-in user: their Agent Platform session and Memory Bank memories are their own.
    const user = company ? (await callerAccount(req.headers.authorization)).body.data?.user ?? null : null;
    const turn = {
      messages,
      sessionId: body.sessionId,
      company,
      access,
      user: user && { id: user.id },
      requestId,
      // The browser demo sends its own orders and playbook; a company chat never uses what the client sends.
      demo: company ? null : { orders: demoOrders(body.demo?.orders), playbook: demoPlaybook(body.demo?.rules) },
    };
    if (AGENTS_AT) {
      // The agents run on Agent Runtime (agents/remote.js): relay their events. The user's token
      // goes along only so the agents can read the company's orders and playbook with it.
      const token = company ? req.headers.authorization.replace(/^Bearer /, "") : undefined;
      for await (const event of streamTurn({ ...turn, backendToken: token })) {
        write(event);
        if (event.type === "done") logChat(event.audit, trace);
        if (event.type === "error") log("ERROR", "chat.agents_error", { requestId, trace, auditId: event.auditId });
      }
    } else {
      const result = await runAgent({
        ...turn,
        // The company's orders and playbook are read with the caller's own token (query_orders, get_playbook).
        backend: company ? (path) => backendGet(path, req.headers.authorization) : null,
        onStep: (step) => write({ type: "step", step: publicStep(step) }),
      });
      logChat(result, trace);
      if (result.status === "error") write({ type: "error", error: "The assistant is unavailable right now.", auditId: result.id });
      else write({ type: "done", reply: result.answer, citations: result.citations, audit: publicAudit(result) });
    }
  } catch (e) {
    log("ERROR", "chat.failed", { requestId, trace, error: String(e?.message || e) });
    write({ type: "error", error: "The assistant is unavailable right now." });
  }
  res.end();
}

// A company chat's audits also need that company's token (access.js auditVisible).
async function sessionAudits(query, access) {
  const session = query.get("session") || "";
  if (!SESSION.test(session)) return [400, { error: "Expected ?session=" }];
  const rows = await list(audits.where("sessionId", "==", session).limit(100));
  return [
    200,
    {
      audits: rows
        .filter((a) => auditVisible(a, access))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(publicAudit),
    },
  ];
}

async function oneAudit(id, query, access) {
  const doc = await audits.doc(id).get();
  if (!doc.exists || doc.get("sessionId") !== query.get("session")) return [404, { error: "Audit not found" }];
  const audit = { id: doc.id, ...doc.data() };
  if (!auditVisible(audit, access)) return [404, { error: "Audit not found" }];
  return [200, { audit: publicAudit(audit) }];
}

async function route(method, path, body, req, query) {
  if (method === "GET" && path === "/api/audits") return sessionAudits(query, await readerAccess(req));
  const a = path.match(/^\/api\/audits\/([\w-]{1,40})$/);
  if (method === "GET" && a) return oneAudit(a[1], query, await readerAccess(req));
  // What Memory Bank remembers about the signed-in user (Account › What the assistant remembers).
  if (path === "/api/memories" || path.startsWith("/api/memories/")) return memoryRoute(method, path, req);
  return [404, { error: "Not found" }];
}

// Only signed-in company users have memories; anyone else gets 401. A memory id that isn't the
// caller's answers like a missing one.
async function memoryRoute(method, path, req) {
  const { status, body } = await callerAccount(req.headers.authorization);
  const account = body.data;
  if (status !== 200 || !account?.company || !account.user) return [401, { error: "Sign in to a company workspace to see what the assistant remembers." }];
  const userKey = userKeyFor({ company: { company: account.company }, user: account.user });
  if (!remembers(userKey)) return [200, { memories: [], enabled: false }];
  if (method === "GET" && path === "/api/memories")
    return [
      200,
      {
        memories: AGENTS_AT ? (await callAgents("list_memories", { userKey })).memories : await listMemories(userKey),
        enabled: true,
        keepDays: await memoryKeepDays(),
      },
    ];
  const m = path.match(/^\/api\/memories\/(\d{1,30})$/);
  if (method === "DELETE" && m) {
    const deleted = AGENTS_AT ? (await callAgents("delete_memory", { userKey, id: m[1] })).deleted : await deleteMemory(userKey, m[1]);
    if (!deleted) return [404, { error: "Memory not found" }];
    log("INFO", "memory.deleted", { userId: account.user.id, companyId: account.company.id });
    return [200, { ok: true }];
  }
  return [404, { error: "Not found" }];
}

http
  .createServer(async (req, res) => {
    const origin = req.headers.origin;
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const requestId = randomUUID();
    res.setHeader("X-Request-Id", requestId);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : "",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "3600",
      });
      return res.end();
    }
    if (req.method === "GET" && (path === "/" || path === "/healthz"))
      return send(res, 200, { ok: true, models: MODELS }, origin);

    let body = {};
    if (req.method === "POST" || req.method === "PATCH") {
      try {
        body = await readJson(req);
      } catch (e) {
        if (e.status === 413) return send(res, 413, { error: "Request body too large" }, origin);
        return send(res, 400, { error: "Invalid JSON" }, origin);
      }
    }
    if (req.method === "POST" && path === "/api/chat") return streamChat(req, res, body, origin, requestId);
    try {
      const [status, payload] = await route(req.method, path, body, req, url.searchParams);
      send(res, status, payload, origin);
    } catch (e) {
      log("ERROR", "request.failed", { requestId, trace: req.headers["x-cloud-trace-context"], method: req.method, path, error: String(e?.message || e) });
      send(res, 502, { error: "The service is unavailable right now." }, origin);
    }
  })
  .listen(PORT, () => log("INFO", `ExportMate AI listening on :${PORT}`, { models: MODELS }));
