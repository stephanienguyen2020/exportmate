import http from "node:http";
import { OAuth2Client } from "google-auth-library";
import { inventory, sources, impacts, scans, list } from "./db.js";
import { fetchFeed } from "./feeds.js";
import { runScan } from "./scan.js";
import { runAgent, audits, clearCaches } from "./agent.js";
import { indexDocs, toDoc, kb } from "./rag.js";

const PORT = Number(process.env.PORT || 8080);
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://exportmate.vercel.app,http://127.0.0.1:5173,http://localhost:5173"
).split(",");
const MAX_MESSAGES = 20;
const MAX_CHARS = 4000;
const MAX_SOURCES = 25;
const SCAN_COOLDOWN_MS = 10 * 60_000;
// Cloud Scheduler signs its requests with this service account; those skip the cooldown.
const SCHEDULER_SA = process.env.SCHEDULER_SA || "";
const SCAN_AUDIENCE = process.env.SCAN_AUDIENCE || "";
const authClient = new OAuth2Client();
// Company backend (FastAPI) origin, for the signed-in company's profile. Chat never reads its
// database; it calls the API with the user's own token (backend/REQUIREMENTS.md 7.2).
const BACKEND_URL = (process.env.BACKEND_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

// The caller's company profile and sites, or null (demo chat, signed out, backend down).
// The user's token is only ever sent to BACKEND_URL and is never logged.
async function companyKnowledge(authorization) {
  if (!/^Bearer \S+$/.test(authorization || "")) return null;
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BACKEND_URL);
  if (!local && !BACKEND_URL.startsWith("https://")) return null;
  try {
    const res = await fetch(`${BACKEND_URL}/api/v1/company/knowledge`, {
      headers: { Authorization: authorization },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn(`Company profile unavailable (${res.status} ${body.error?.code || ""}); answering without it.`);
      return null;
    }
    return body.data;
  } catch (e) {
    console.warn(`Company profile unavailable (${e.name}); answering without it.`);
    return null;
  }
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

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 100_000) reject(new Error("too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
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

// Streams the agent's audit steps as NDJSON, then the final answer and audit record.
async function streamChat(req, res, body, origin) {
  const messages = parseMessages(body.messages);
  if (!messages) return send(res, 400, { error: "Expected messages ending with a user message" }, origin);
  if (!SESSION.test(body.sessionId || "")) return send(res, 400, { error: "Expected a sessionId" }, origin);
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    ...cors(origin),
  });
  const write = (event) => res.write(JSON.stringify(event) + "\n");
  try {
    const company = await companyKnowledge(req.headers.authorization);
    const result = await runAgent({
      messages,
      sessionId: body.sessionId,
      company,
      onStep: (step) => write({ type: "step", step }),
    });
    if (result.status === "error") write({ type: "error", error: "The assistant is unavailable right now.", auditId: result.id });
    else write({ type: "done", reply: result.answer, citations: result.citations, audit: result });
  } catch (e) {
    console.error("Chat failed:", e);
    write({ type: "error", error: "The assistant is unavailable right now." });
  }
  res.end();
}

async function sessionAudits(query) {
  const session = query.get("session") || "";
  if (!SESSION.test(session)) return [400, { error: "Expected ?session=" }];
  const rows = await list(audits.where("sessionId", "==", session).limit(100));
  return [200, { audits: rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }];
}

async function oneAudit(id, query) {
  const doc = await audits.doc(id).get();
  if (!doc.exists || doc.get("sessionId") !== query.get("session")) return [404, { error: "Audit not found" }];
  return [200, { audit: { id: doc.id, ...doc.data() } }];
}

async function latestScan() {
  const snap = await scans.orderBy("startedAt", "desc").limit(1).get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

async function scanNow(scheduled) {
  const last = await latestScan();
  if (scheduled && last?.status === "running" && Date.now() - Date.parse(last.startedAt) < SCAN_COOLDOWN_MS)
    return [409, { error: "A scan is already running.", scan: last }];
  if (!scheduled && last && Date.now() - Date.parse(last.startedAt) < SCAN_COOLDOWN_MS)
    return [429, { error: last.status === "running" ? "A scan is already running." : "A scan ran in the last 10 minutes.", scan: last }];
  const scan = await runScan({ trigger: scheduled ? "schedule" : "manual" });
  clearCaches();
  return [200, { scan }];
}

async function addSource(body) {
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!name || !url) return [400, { error: "Name and feed URL are required." }];
  const existing = await list(sources);
  if (existing.length >= MAX_SOURCES) return [400, { error: `Up to ${MAX_SOURCES} sources.` }];
  if (existing.some((s) => s.url === url)) return [409, { error: "That feed is already a source." }];
  let sample;
  try {
    sample = await fetchFeed(url, { limit: 3 });
  } catch (e) {
    return [400, { error: `Couldn't read that feed: ${e.message}` }];
  }
  const source = { name, url, kind: "Custom", builtIn: false, enabled: true, addedAt: new Date().toISOString() };
  const ref = await sources.add(source);
  await indexDocs([toDoc.source({ id: ref.id, ...source })]).catch((e) => console.error("Indexing failed:", e));
  clearCaches();
  return [201, { source: { id: ref.id, ...source }, sample }];
}

async function route(method, path, body, req, query) {
  if (method === "GET" && path === "/api/audits") return sessionAudits(query);
  const a = path.match(/^\/api\/audits\/([\w-]{1,40})$/);
  if (method === "GET" && a) return oneAudit(a[1], query);
  if (method === "GET" && path === "/api/inventory") return [200, { items: await list(inventory.orderBy("sku")) }];
  if (method === "GET" && path === "/api/impacts")
    return [200, { impacts: await list(impacts.orderBy("createdAt", "desc").limit(60)), scan: await latestScan() }];
  if (method === "POST" && path === "/api/scan") return scanNow(await fromScheduler(req));
  if (method === "GET" && path === "/api/sources") return [200, { sources: await list(sources.orderBy("name")) }];
  if (method === "POST" && path === "/api/sources") return addSource(body);
  const m = path.match(/^\/api\/sources\/([\w-]{1,40})$/);
  if (m && (method === "PATCH" || method === "DELETE")) {
    const ref = sources.doc(m[1]);
    const doc = await ref.get();
    if (!doc.exists) return [404, { error: "Source not found" }];
    if (method === "DELETE") {
      if (doc.data().builtIn) return [400, { error: "Built-in sources can be turned off, not deleted." }];
      await Promise.all([ref.delete(), kb.doc(`source:${m[1]}`).delete()]);
      clearCaches();
      return [200, { ok: true }];
    }
    if (typeof body.enabled !== "boolean") return [400, { error: "Expected { enabled: boolean }" }];
    await ref.update({ enabled: body.enabled });
    await indexDocs([toDoc.source({ id: m[1], ...doc.data(), enabled: body.enabled })]).catch((e) => console.error("Indexing failed:", e));
    clearCaches();
    return [200, { ok: true }];
  }
  return [404, { error: "Not found" }];
}

http
  .createServer(async (req, res) => {
    const origin = req.headers.origin;
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
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
      } catch {
        return send(res, 400, { error: "Invalid JSON" }, origin);
      }
    }
    if (req.method === "POST" && path === "/api/chat") return streamChat(req, res, body, origin);
    try {
      const [status, payload] = await route(req.method, path, body, req, url.searchParams);
      send(res, status, payload, origin);
    } catch (e) {
      console.error(`${req.method} ${path} failed:`, e);
      send(res, 502, { error: "The service is unavailable right now." }, origin);
    }
  })
  .listen(PORT, () => console.log(`ExportMate AI listening on :${PORT} (model ${MODEL})`));
