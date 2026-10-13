import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { FieldValue } from "@google-cloud/firestore";
import { OAuth2Client } from "google-auth-library";
import { db, inventory, sources, impacts, scans, companySources, locks, list } from "./db.js";
import { fetchFeed } from "./feeds.js";
import { runScan } from "./scan.js";
import { runAgent, audits, clearCaches } from "./agent.js";
import { indexDocs, toDoc, kb } from "./rag.js";
import { log } from "./log.js";
import { ANONYMOUS, auditVisible, isShared, presentSources, publicAudit, publicStep, sourceVisible, visibleItems } from "./access.js";
import { readJson, scanBlocked } from "./limits.js";

const PORT = Number(process.env.PORT || 8080);
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://exportmate.vercel.app,http://127.0.0.1:5173,http://localhost:5173"
).split(",");
const MAX_MESSAGES = 20;
const MAX_CHARS = 4000;
// Custom feeds each company may add, and in all (every enabled feed is read by each scan).
const MAX_COMPANY_SOURCES = 10;
const MAX_SOURCES = 100;
// Cloud Scheduler signs its requests with this service account; those skip the cooldown.
const SCHEDULER_SA = process.env.SCHEDULER_SA || "";
const SCAN_AUDIENCE = process.env.SCAN_AUDIENCE || "";
const authClient = new OAuth2Client();
// Company backend (FastAPI) origin, for the signed-in company's profile and role. This service
// never reads its database; it calls the API with the user's own token (backend/docs/DECISIONS.md §2).
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

// Shared sources a company switched off for itself, kept briefly per instance.
const disabledCache = new Map();
async function disabledSources(companyId) {
  const hit = disabledCache.get(companyId);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const doc = await companySources.doc(companyId).get();
  const value = doc.exists && Array.isArray(doc.get("disabled")) ? doc.get("disabled") : [];
  disabledCache.set(companyId, { at: Date.now(), value });
  return value;
}

// What a reader sees: anonymous (demo) unless a valid company token came with the request.
async function readerAccess(req) {
  if (!req.headers.authorization) return ANONYMOUS;
  const { status, body } = await callerAccount(req.headers.authorization);
  const companyId = status === 200 ? body.data?.company?.id : null;
  return companyId ? { companyId, disabled: await disabledSources(companyId) } : ANONYMOUS;
}

// The caller's company profile and sites, or null (demo chat, signed out, backend down).
async function companyKnowledge(authorization) {
  if (!/^Bearer \S+$/.test(authorization || "")) return null;
  const { status, body, reason } = await backendGet("/api/v1/company/knowledge", authorization);
  if (status === 200) return body.data;
  log("WARNING", "company_profile.unavailable", { reason: reason || `${status} ${body.error?.code || ""}`.trim() });
  return null;
}

// Changing sources and starting a scan need a signed-in company owner or editor; the backend
// checks the token and reports the role. `action` completes "… can …", e.g. "change news sources".
// Returns { userId, companyId, disabled } for the change and its log, or { error: [status, payload] }.
async function companyEditor(req, action) {
  const { status, body, reason } = await callerAccount(req.headers.authorization);
  const account = body.data;
  if (status === 200 && account?.company && ["owner", "editor"].includes(account.role))
    return { userId: account.user.id, companyId: account.company.id, disabled: await disabledSources(account.company.id) };
  if (status === 200) return { error: [403, { error: `Only company owners and editors can ${action}.` }] };
  if (status === 401) return { error: [401, { error: `Sign in to a company workspace to ${action}.` }] };
  if (status === 403) return { error: [403, { error: body.error?.message || `Your account can't ${action}.` }] };
  log("WARNING", "company_check.backend_unavailable", { action, reason: reason || status });
  return { error: [503, { error: "This can't be changed right now. Please try again later." }] };
}

// The caller's address. Vercel replaces X-Forwarded-For with the visitor's address and Cloud Run
// appends the hop it saw, so the first entry is the visitor. A caller going straight to Cloud Run
// can fake it; the per-instance cap still bounds what they can spend.
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

async function fromScheduler(req) {
  const token = (req.headers.authorization || "").match(/^Bearer (.+)$/)?.[1];
  if (!token || !SCHEDULER_SA || !SCAN_AUDIENCE) return false;
  try {
    const ticket = await authClient.verifyIdToken({ idToken: token, audience: SCAN_AUDIENCE });
    const p = ticket.getPayload();
    return p?.email === SCHEDULER_SA && p.email_verified === true;
  } catch {
    return false;
  }
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
    const access = company ? { companyId: company.company.id, disabled: await disabledSources(company.company.id) } : ANONYMOUS;
    const result = await runAgent({
      messages,
      sessionId: body.sessionId,
      company,
      access,
      requestId,
      onStep: (step) => write({ type: "step", step: publicStep(step) }),
    });
    logChat(result, trace);
    if (result.status === "error") write({ type: "error", error: "The assistant is unavailable right now.", auditId: result.id });
    else write({ type: "done", reply: result.answer, citations: result.citations, audit: publicAudit(result) });
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

async function latestScan() {
  const snap = await scans.orderBy("startedAt", "desc").limit(1).get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

// One scan at a time across instances: the lock document is claimed in a transaction, so two
// requests (or the scheduler and a person) can't both pass the check and start.
const scanLock = locks.doc("scan");
async function scanNow(scheduled, who = {}) {
  const blocked = await db.runTransaction(async (t) => {
    const lock = (await t.get(scanLock)).data();
    const refusal = scanBlocked(lock, { scheduled });
    if (!refusal) t.set(scanLock, { startedAt: new Date().toISOString(), running: true, trigger: scheduled ? "schedule" : "manual", ...who });
    return refusal;
  });
  if (blocked) return [blocked[0], { error: blocked[1], scan: await latestScan() }];
  try {
    const scan = await runScan({ trigger: scheduled ? "schedule" : "manual" });
    clearCaches();
    return [200, { scan }];
  } finally {
    await scanLock.set({ running: false }, { merge: true }).catch((e) => log("ERROR", "scan.unlock_failed", { error: String(e?.message || e) }));
  }
}

// A custom source belongs to the company that adds it (access.js).
async function addSource(body, editor) {
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!name || !url) return [400, { error: "Name and feed URL are required." }];
  const existing = await list(sources);
  if (existing.filter((s) => s.companyId === editor.companyId).length >= MAX_COMPANY_SOURCES)
    return [400, { error: `Up to ${MAX_COMPANY_SOURCES} custom sources per company.` }];
  if (existing.length >= MAX_SOURCES) return [400, { error: "No more sources can be added right now." }];
  if (existing.some((s) => s.url === url && sourceVisible(s, editor))) return [409, { error: "That feed is already a source." }];
  let sample;
  try {
    sample = await fetchFeed(url, { limit: 3 });
  } catch (e) {
    return [400, { error: `Couldn't read that feed: ${e.message}` }];
  }
  const source = {
    name,
    url,
    kind: "Custom",
    builtIn: false,
    enabled: true,
    companyId: editor.companyId,
    addedBy: editor.userId,
    addedAt: new Date().toISOString(),
  };
  const ref = await sources.add(source);
  await indexDocs([toDoc.source({ id: ref.id, ...source })]).catch((e) => log("ERROR", "index.failed", { sourceId: ref.id, error: String(e?.message || e) }));
  clearCaches();
  log("INFO", "source.added", { sourceId: ref.id, userId: editor.userId, companyId: editor.companyId });
  const [shown] = presentSources([{ id: ref.id, ...source }], editor);
  return [201, { source: shown, sample }];
}

// Switching a shared source off only affects the caller's company; a company's own source is
// switched off for real (it is the only one reading it).
async function setSourceEnabled(source, enabled, editor) {
  if (isShared(source)) {
    await companySources
      .doc(editor.companyId)
      .set(
        { disabled: enabled ? FieldValue.arrayRemove(source.id) : FieldValue.arrayUnion(source.id), updatedAt: new Date().toISOString(), updatedBy: editor.userId },
        { merge: true },
      );
    disabledCache.delete(editor.companyId);
  } else {
    await sources.doc(source.id).update({ enabled });
    await indexDocs([toDoc.source({ ...source, enabled })]).catch((e) => log("ERROR", "index.failed", { sourceId: source.id, error: String(e?.message || e) }));
  }
  clearCaches();
  log("INFO", enabled ? "source.enabled" : "source.disabled", { sourceId: source.id, shared: isShared(source), userId: editor.userId, companyId: editor.companyId });
}

async function route(method, path, body, req, query) {
  if (method === "GET" && path === "/api/audits") return sessionAudits(query, await readerAccess(req));
  const a = path.match(/^\/api\/audits\/([\w-]{1,40})$/);
  if (method === "GET" && a) return oneAudit(a[1], query, await readerAccess(req));
  if (method === "GET" && path === "/api/inventory") return [200, { items: await list(inventory.orderBy("sku")) }];
  if (method === "GET" && path === "/api/impacts") {
    const [access, stored, all, scan] = await Promise.all([
      readerAccess(req),
      list(impacts.orderBy("createdAt", "desc").limit(120)),
      list(sources),
      latestScan(),
    ]);
    return [200, { impacts: visibleItems(stored, all, access).slice(0, 60), scan }];
  }
  if (method === "POST" && path === "/api/scan") {
    if (await fromScheduler(req)) return scanNow(true);
    const editor = await companyEditor(req, "run a scan");
    return editor.error || scanNow(false, { userId: editor.userId, companyId: editor.companyId });
  }
  if (method === "GET" && path === "/api/sources") {
    const [access, all] = await Promise.all([readerAccess(req), list(sources.orderBy("name"))]);
    return [200, { sources: presentSources(all, access) }];
  }
  if (method === "POST" && path === "/api/sources") {
    const editor = await companyEditor(req, "change news sources");
    return editor.error || addSource(body, editor);
  }
  const m = path.match(/^\/api\/sources\/([\w-]{1,40})$/);
  if (m && (method === "PATCH" || method === "DELETE")) {
    const editor = await companyEditor(req, "change news sources");
    if (editor.error) return editor.error;
    const doc = await sources.doc(m[1]).get();
    const source = doc.exists ? { id: doc.id, ...doc.data() } : null;
    // Another company's source answers like a missing one.
    if (!source || !sourceVisible(source, editor)) return [404, { error: "Source not found" }];
    if (method === "DELETE") {
      if (source.builtIn) return [400, { error: "Built-in sources can be turned off, not deleted." }];
      if (isShared(source)) return [400, { error: "This source is shared by every workspace. Switch it off instead." }];
      await Promise.all([sources.doc(m[1]).delete(), kb.doc(`source:${m[1]}`).delete()]);
      clearCaches();
      log("INFO", "source.deleted", { sourceId: m[1], userId: editor.userId, companyId: editor.companyId });
      return [200, { ok: true }];
    }
    if (typeof body.enabled !== "boolean") return [400, { error: "Expected { enabled: boolean }" }];
    await setSourceEnabled(source, body.enabled, editor);
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
      return send(res, 200, { ok: true, model: MODEL }, origin);

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
  .listen(PORT, () => log("INFO", `ExportMate AI listening on :${PORT}`, { model: MODEL }));
