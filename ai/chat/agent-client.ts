// Client for the agent API: streams audit steps (NDJSON) and returns the answer.
import { isApiSession } from "../../src/account-store";
import { getToken } from "../../src/auth";

export type Citation = {
  ref: number;
  type: string;
  id: string;
  title: string;
  url?: string;
  publishedAt?: string;
  source?: string;
};

export type AuditResult = { ref: number; type: string; title: string; score?: number; excerpt?: string };

export type AuditStep = {
  at: number;
  kind: "plan" | "tool" | "draft" | "review" | "answer";
  latencyMs?: number;
  thought?: string;
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
  problems?: string[];
  excerpt?: string;
  finishReason?: string;
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
  status: string;
  error?: string;
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

// In a company workspace the assistant also knows the company: the AI service
// fetches its profile from the backend with this token. The demo stays anonymous.
async function companyAuth(): Promise<Record<string, string>> {
  if (!isApiSession()) return {};
  try {
    return { Authorization: `Bearer ${await getToken()}` };
  } catch {
    return {};
  }
}

export async function askAgent(
  messages: Message[],
  onStep: (step: AuditStep) => void,
): Promise<{ reply: string; citations: Citation[]; audit: Audit }> {
  const res = await fetch(`${API}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await companyAuth()) },
    body: JSON.stringify({
      sessionId: sessionId(),
      // Earlier answers carry the titles they cited so follow-ups can refer to them.
      messages: messages.map((m) => ({
        role: m.role,
        text: m.text,
        sources: m.citations?.map((c) => `${c.type}: ${c.title}`),
      })),
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

export async function sessionAudits(): Promise<Audit[]> {
  const res = await fetch(`${API}/audits?session=${encodeURIComponent(sessionId())}`);
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
