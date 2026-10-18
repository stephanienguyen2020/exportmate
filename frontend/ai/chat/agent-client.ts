// Client for the agent API: streams audit steps (NDJSON) and returns the answer.
import { isApiSession } from "../../src/account-store";
import { getToken } from "../../src/auth";
import {
  destinationCountry,
  initialOrders,
  initialRules,
  readSaved,
  sampleCheck,
  sampleObligation,
  withSampleRisk,
  type Order,
  type Rule,
} from "../../src/data";

export type Citation = {
  ref: number;
  type: string;
  id: string;
  title: string;
  url?: string;
  publishedAt?: string;
  source?: string;
};

export type AuditResult = {
  ref: number;
  type: string;
  title: string;
  score?: number;
  // Hybrid retrieval: BM25 match of the query's exact terms, 0-1.
  lexical?: number;
  // Age of the news it came from, in days.
  ageDays?: number;
  excerpt?: string;
};

// A third-party passage the guard withheld from the model (prompt injection).
export type GuardFlag = { where: string; match: string };

export type AuditStep = {
  at: number;
  // cache: the answer was reused from an earlier audit (auditId, answeredAt); its steps follow.
  // delegate: a specialist's report to the analyst (agent, request, excerpt).
  // memory: what Memory Bank recalled about the signed-in user before the turn (facts).
  kind: "plan" | "tool" | "draft" | "review" | "answer" | "cache" | "delegate" | "memory";
  // The agent that made the step: quick_answer, analyst or a specialist (stock_specialist, …).
  agent?: string;
  request?: string;
  facts?: string[];
  latencyMs?: number;
  note?: string;
  calls?: { name: string; args: Record<string, unknown> }[];
  tokens?: { prompt?: number; output?: number; thinking?: number };
  name?: string;
  args?: Record<string, unknown>;
  count?: number;
  totalStockValueUsd?: number;
  expression?: string;
  result?: number;
  results?: AuditResult[];
  error?: string;
  // Why a tool call failed: invalid_args | denied | budget | unknown_tool | timeout | unavailable | failed.
  errorKind?: string;
  // Present when a transient failure was retried.
  attempts?: number;
  flags?: GuardFlag[];
  problems?: string[];
  // review: who sent the draft back, the auditor (code checks) or the critic (Gemini, graph paths).
  by?: "auditor" | "critic";
  excerpt?: string;
  finishReason?: string;
  // The model that made this call (plan, draft, answer); the router picks it per question.
  model?: string;
  auditId?: string;
  answeredAt?: string;
};

export type Audit = {
  id: string;
  sessionId: string;
  createdAt: string;
  question: string;
  answer: string;
  model: string;
  embeddingModel: string;
  steps: AuditStep[];
  citations: Citation[];
  retrieved: Citation[];
  checks: { name: string; ok: boolean; detail: string }[];
  usage: { promptTokens: number; outputTokens: number; thinkingTokens: number; modelCalls: number };
  latencyMs: number;
  // ok | needs_review (auditor checks still fail after the revision) | max_steps | error
  status: string;
  error?: string;
  policyVersion?: string;
  requestId?: string;
  flags?: GuardFlag[];
  // The router's choice: simple (small fast model) or complex, the signals behind it, and
  // whether a simple-tier draft the auditor sent back was revised on the complex tier.
  // agent: who the router chose; answeredBy: who wrote the answer (the analyst after an escalation).
  route?: { tier: "simple" | "complex"; reasons: string[]; escalated?: boolean; agent?: string; answeredBy?: string };
  usageByAgent?: Record<string, { promptTokens: number; outputTokens: number; thinkingTokens: number; modelCalls: number }>;
  // Present when the answer was reused from an earlier audit against the same data.
  cache?: { auditId: string; answeredAt: string };
};

export type Message = { role: "user" | "model"; text: string; citations?: Citation[]; audit?: Audit };

export const API = (import.meta.env.VITE_CHAT_API_URL || "/api/chat").replace(/\/chat$/, "");

const SESSION_KEY = "em-chat-session";
const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

export function sessionId(reset = false) {
  try {
    let id = reset ? "" : sessionStorage.getItem(SESSION_KEY) || "";
    if (!id) {
      id = newId();
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return newId();
  }
}

// In a company workspace the AI service checks this token with the backend: chat
// uses it to load the company profile, News watch to allow source changes. The
// demo stays anonymous.
export async function companyAuth(): Promise<Record<string, string>> {
  if (!isApiSession()) return {};
  try {
    return { Authorization: `Bearer ${await getToken()}` };
  } catch {
    return {};
  }
}

// The browser demo's orders and playbook live in this browser, so the assistant can only
// see them if they travel with the question. Orders needing action go first, then by ship
// date, within the AI service's limits (ai/server/orders.js).
const DEMO_ORDERS_SENT = 100;
export function demoWorkspace() {
  const orders = readSaved<Order[]>("em-orders", initialOrders, Array.isArray)
    .filter((o) => o && typeof o.id === "string")
    .map(withSampleRisk)
    .sort((a, b) => Number(b.risk) - Number(a.risk) || a.shipDate.localeCompare(b.shipDate));
  const rules = readSaved<Rule[]>("em-rules", initialRules, Array.isArray);
  return {
    orders: orders.slice(0, DEMO_ORDERS_SENT).map((o) => {
      const check = sampleCheck(o);
      const country = destinationCountry(o.destination);
      return {
        id: o.id,
        product: o.product,
        supplier: o.supplier,
        destination: o.destination,
        market: check ? sampleObligation.market : country,
        value: o.value,
        currency: o.currency || "USD",
        shipDate: o.shipDate,
        hsCode: o.hsCode,
        status: o.risk ? "exposed" : "clear",
        check: check && { title: `${sampleObligation.title} (sample rule)`, ...check },
      };
    }),
    rules: rules.filter((r) => r && r.enabled).map(({ id, category, text }) => ({ id, category, text })),
  };
}

export async function askAgent(
  messages: Message[],
  onStep: (step: AuditStep) => void,
  signal?: AbortSignal,
): Promise<{ reply: string; citations: Citation[]; audit: Audit }> {
  const res = await fetch(`${API}/chat`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", ...(await companyAuth()) },
    body: JSON.stringify({
      sessionId: sessionId(),
      // Earlier answers carry the titles they cited so follow-ups can refer to them.
      messages: messages.map((m) => ({
        role: m.role,
        text: m.text,
        sources: m.citations?.map((c) => `${c.type}: ${c.title}`),
      })),
      // A company workspace's orders and playbook are read from the backend instead.
      ...(isApiSession() ? {} : { demo: demoWorkspace() }),
    }),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `The assistant is unavailable (${res.status}).`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === "step") onStep(event.step);
      else if (event.type === "done") return event;
      else if (event.type === "error") throw new Error(event.error);
    }
    if (done) throw new Error("The assistant stopped before answering.");
  }
}

// A company chat's audits are only returned with that company's token.
export async function sessionAudits(): Promise<Audit[]> {
  const res = await fetch(`${API}/audits?session=${encodeURIComponent(sessionId())}`, { headers: await companyAuth() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Couldn't load the audit trail.");
  return data.audits;
}

export function downloadJson(filename: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// What Memory Bank remembers about the signed-in company user (Account page).
export type Memory = { id: string; fact: string; updatedAt?: string };

// keepDays: how long Memory Bank keeps a memory, from the Agent Runtime instance (null if unknown).
export type MemoryList = { memories: Memory[]; enabled: boolean; keepDays?: number | null };

export async function listMemories(): Promise<MemoryList> {
  const res = await fetch(`${API}/memories`, { headers: await companyAuth() });
  // An AI service from before Memory Bank has no such route: memory isn't on there.
  if (res.status === 404) return { memories: [], enabled: false };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Couldn't load what the assistant remembers.");
  return data;
}

export async function deleteMemory(id: string): Promise<void> {
  const res = await fetch(`${API}/memories/${encodeURIComponent(id)}`, { method: "DELETE", headers: await companyAuth() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Couldn't forget that.");
}
