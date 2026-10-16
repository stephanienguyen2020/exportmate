// Answer cache: a question already answered is not sent to Gemini again. Pure functions; the
// Firestore side (`answer_cache` collection, shared by every instance) is in agent.js.
//
// A cached answer is reused only when everything it depended on is unchanged. The key covers
// the conversation (normalised), the company and the sources it switched off, the policy
// version, the models, today's date (the prompt carries it and news ages count from it) and a
// fingerprint of the data the tools read: stock, sources, the latest scan (new articles and
// alerts) and the company profile. A scan, a source change, a stock change or a profile edit
// therefore makes a new key, so stale answers are never served; old entries expire (expireAt).
// Tools marked `live` read data outside that fingerprint (e.g. orders from Postgres), so an
// answer that called one is never cached (agent.js).
import { createHash } from "node:crypto";

export const CACHE_VERSION = 1; // bump to drop every cached answer
export const CACHE_TTL_MS = 2 * 86_400_000;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** JSON with object keys sorted, so the same data always hashes the same. */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object" && !(value instanceof Date))
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

export const fingerprint = (value) => sha256(stableJson(value)).slice(0, 32);

/** "  What's the stock value of ABC-101??" and "what's the stock value of abc-101" are one question. */
export const normalizeText = (text) =>
  String(text ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s?!.。？！]+$/u, "")
    .trim();

/**
 * The cache document id for a conversation in a given company, data state and day. `userKey` is
 * set for users whose remembered preferences (Memory Bank) can shape the answer.
 */
export function answerKey({ messages, companyId = null, userKey = null, disabled = [], skipOld = true, dataVersion, policyVersion, models, day }) {
  return sha256(
    stableJson({
      v: CACHE_VERSION,
      conversation: messages.map((m) => [m.role, normalizeText(m.text), ...(m.role === "model" ? [m.sources || []] : [])]),
      companyId,
      ...(userKey ? { userKey } : {}),
      disabled: [...disabled].sort(),
      // A company that switched the age rule off sees alerts from older articles (access.js).
      ...(skipOld === false ? { skipOld } : {}),
      dataVersion,
      policyVersion,
      models,
      day,
    }),
  );
}

/** Only clean answers are reused: passed every auditor check, and no tool failed along the way. */
export const cacheable = (audit) =>
  audit.status === "ok" &&
  Boolean(audit.answer) &&
  (audit.checks || []).every((c) => c.ok) &&
  !(audit.steps || []).some((s) => s.kind === "tool" && s.error);

/**
 * The audit for a turn answered from the cache: the original answer, citations and checks, its
 * trail after a "cache" step naming the original audit, and no model usage of its own.
 */
export function cachedAudit(original, { sessionId, requestId, channel, companyId, question, startedAt, latencyMs }) {
  const step = { at: 0, kind: "cache", auditId: original.id, answeredAt: original.createdAt };
  return {
    sessionId,
    requestId,
    channel,
    companyId,
    createdAt: new Date(startedAt).toISOString(),
    question,
    model: original.model,
    embeddingModel: original.embeddingModel,
    policyVersion: original.policyVersion,
    ...(original.route ? { route: original.route } : {}),
    cache: { auditId: original.id, answeredAt: original.createdAt },
    steps: [step, ...(original.steps || [])],
    usage: { promptTokens: 0, outputTokens: 0, thinkingTokens: 0, modelCalls: 0 },
    status: "ok",
    answer: original.answer,
    checks: original.checks,
    citations: original.citations,
    retrieved: original.retrieved,
    ...(original.flags?.length ? { flags: original.flags } : {}),
    latencyMs,
  };
}
