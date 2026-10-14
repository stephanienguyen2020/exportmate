// Agent Platform services for the assistant: Sessions and Memory Bank on the Agent Runtime
// instance named by AGENT_RUNTIME (projects/…/locations/…/reasoningEngines/…, created by
// platform/runtime.py). Without it (local runs, tests) sessions are in memory and nothing is
// remembered.
//
// Who is who: a signed-in company user is `${companyId}:${userId}`; the browser demo is
// `demo:${sessionId}` (its sessions expire after a day and it gets no memories).
import { createHash } from "node:crypto";
import { InMemorySessionService, VertexAiMemoryBankService, VertexAiSessionService } from "@google/adk";
import { GoogleAuth } from "google-auth-library";
import { db } from "../db.js";

export const APP = "exportmate";
const RUNTIME = /^projects\/([^/]+)\/locations\/([^/]+)\/reasoningEngines\/(\d+)$/.exec(process.env.AGENT_RUNTIME || "");
export const runtime = RUNTIME ? { name: RUNTIME[0], project: RUNTIME[1], location: RUNTIME[2], id: RUNTIME[3] } : null;

const options = runtime && { projectId: runtime.project, location: runtime.location, agentEngineId: runtime.id };
export const sessionService = runtime ? new VertexAiSessionService(options) : null;
export const memoryService = runtime ? new VertexAiMemoryBankService(options) : null;

// Browser session → Agent Platform session. The document id hashes the user with the browser's
// session id, so nobody can continue (or reset) another user's session by sending their id.
const chatSessions = db.collection("chat_sessions");
const SESSION_TTL = { demo: "86400s", company: `${30 * 86400}s` };

/** The user key a chat runs as: company users are remembered, demo sessions are not. */
export function userKeyFor({ company, user, sessionId }) {
  return company && user?.id ? `${company.company.id}:${user.id}` : `demo:${sessionId}`;
}

export const remembers = (userKey) => Boolean(memoryService) && !userKey.startsWith("demo:");

/**
 * The session for this chat turn: the persistent Agent Platform session when configured
 * (`fresh` when it was just created), otherwise a new in-memory one.
 */
export async function chatSession({ sessionId, userKey, persistent }) {
  if (!sessionService || !persistent) {
    const service = new InMemorySessionService();
    return { service, session: await service.createSession({ appName: APP, userId: userKey }), fresh: true };
  }
  const ref = chatSessions.doc(createHash("sha256").update(`${userKey}\n${sessionId}`).digest("hex").slice(0, 40));
  const known = (await ref.get()).data();
  if (known) {
    const session = await sessionService.getSession({ appName: APP, userId: userKey, sessionId: known.agentSessionId }).catch(() => null);
    if (session) return { service: sessionService, session, fresh: false };
  }
  const session = await sessionService.createSession({ appName: APP, userId: userKey, ttl: SESSION_TTL[userKey.startsWith("demo:") ? "demo" : "company"] });
  await ref.set({ agentSessionId: session.id, createdAt: new Date().toISOString(), expireAt: new Date(Date.now() + 31 * 86_400_000) });
  return { service: sessionService, session, fresh: true };
}

// Memory Bank calls ADK's service doesn't offer (listing and deleting one user's memories).
const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
async function memoryApi(method, path, data) {
  const client = await auth.getClient();
  const res = await client.request({ url: `https://${runtime.location}-aiplatform.googleapis.com/v1beta1/${runtime.name}/${path}`, method, data });
  return res.data;
}
const scopeOf = (userKey) => ({ app_name: APP, user_id: userKey });

/** Everything Memory Bank remembers about one user, newest first. */
export async function listMemories(userKey) {
  if (!remembers(userKey)) return [];
  const data = await memoryApi("POST", "memories:retrieve", { scope: scopeOf(userKey), simpleRetrievalParams: { pageSize: 100 } });
  return (data.retrievedMemories || [])
    .map(({ memory }) => ({ id: memory.name.split("/").pop(), fact: memory.fact, updatedAt: memory.updateTime }))
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

/** Deletes one memory if it belongs to this user; false when it doesn't exist or isn't theirs. */
export async function deleteMemory(userKey, id) {
  if (!remembers(userKey) || !/^\d{1,30}$/.test(String(id))) return false;
  const memory = await memoryApi("GET", `memories/${id}`).catch((e) => (e.response?.status === 404 ? null : Promise.reject(e)));
  if (!memory || memory.scope?.app_name !== APP || memory.scope?.user_id !== userKey) return false;
  await memoryApi("DELETE", `memories/${id}`);
  return true;
}
