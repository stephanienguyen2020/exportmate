// The ExportMate assistant: a Google ADK LlmAgent on Gemini (Vertex AI). ADK runs the
// ReAct loop (plan, call tools, observe, repeat) and holds the conversation in a
// session; the harness plugs into it:
// - policy.js: the prompt's rules, each tied to the failure it prevents (versioned);
// - gateway.js: every tool call is validated, scoped, budgeted, timed out and retried;
// - guard.js: third-party text in tool results is treated as data (injection removed);
// - review.js: an auditor checks the draft (citations, figures, links) and sends it back once;
// - router.js: each question goes to a small fast model or the bigger one (models.js);
// - answer-cache.js: a question already answered against the same data isn't answered again.
// Every step is streamed and stored in an audit document (`audits` collection).
import { FieldValue } from "@google-cloud/firestore";
import { Runner, createEvent, LogLevel, setLogger } from "@google/adk";
import { FunctionCallingConfigMode } from "@google/genai";
import { db, inventory, sources, answerCache, list } from "./db.js";
import { EMBED_MODEL } from "./rag.js";
import { toolGateway } from "./gateway.js";
import { POLICY_VERSION } from "./policy.js";
import { review, stripRefs, toEvidence } from "./review.js";
import { log } from "./log.js";
import { ANONYMOUS, presentSources } from "./access.js";
import { TIERS, thinkingFor } from "./models.js";
import { routeQuestion } from "./router.js";
import { answerKey, cacheable, cachedAudit, fingerprint, CACHE_TTL_MS } from "./answer-cache.js";
import { GUIDES } from "./seed/guides.js";
import { LIVE_TOOLS, REGISTRY, UnknownToolPlugin, cached, clearCaches, lastDoneScan, makeRefs, withStockLists, workspaceReaders } from "./agents/tools.js";
import { ANSWERING, buildAssistant } from "./agents/assistant.js";
import { APP, chatSession, memoryService, remembers, userKeyFor } from "./agents/platform.js";

export { clearCaches };
export const audits = db.collection("audits");
const MAX_STEPS = 6; // model calls per answering agent per message
const SPECIALIST_STEPS = 3; // per specialist request
const TOOL_BUDGET = 16;

// ADK's own log lines go through log.js (JSON on Cloud Run); its per-request info lines are dropped.
const adkLog = (severity) => (...args) => log(severity, `adk.${severity.toLowerCase()}`, { detail: args.join(" ").slice(0, 500) });
const adkWarn = adkLog("WARNING");
const adkError = adkLog("ERROR");
setLogger({
  log: (level, ...args) => (level >= LogLevel.ERROR ? adkError(...args) : level >= LogLevel.WARN ? adkWarn(...args) : undefined),
  debug: () => {},
  info: () => {},
  warn: adkWarn,
  error: adkError,
  setLogLevel: () => {},
});

// Answer cache (answer-cache.js). Help guides change only with a deploy, so their hash is fixed.
const GUIDES_VERSION = fingerprint(GUIDES);
const MODELS = { simple: TIERS.simple.model, complex: TIERS.complex.model };
let scanSeen;

// Everything the tools read for this caller, as one hash: stock, the sources as this company
// sees them (with their last fetch), the latest finished scan (its articles and alerts), the
// company profile and the guides. A cached answer is only reused while this is unchanged.
async function dataVersion(company, access, session) {
  const scan = await lastDoneScan();
  // A scan on another instance: drop this instance's copies so tools and the key agree.
  if (scan?.id !== scanSeen) {
    clearCaches();
    scanSeen = scan?.id;
  }
  const [items, stored] = await Promise.all([cached("inventory", () => list(inventory)), cached("sources", () => list(sources))]);
  // Which order and playbook tools were offered: they change the prompt, though what they read is live.
  const tools = { orders: Boolean(session.orders), playbook: Boolean(session.playbook) };
  return fingerprint({ items, sources: presentSources(stored, access), scan: scan?.id ?? null, company, tools, guides: GUIDES_VERSION });
}

// The audit that answered this key before, if it is still there and still fit to reuse.
async function cachedAnswer(key, companyId = null) {
  const entry = await answerCache.doc(key).get();
  if (!entry.exists || entry.get("expireAt")?.toMillis() < Date.now()) return null;
  const doc = await audits.doc(entry.get("auditId")).get();
  if (!doc.exists) return null;
  const original = { id: doc.id, ...doc.data() };
  // The key already names the company; checked again so an entry can never cross companies.
  return (original.companyId ?? null) === companyId && cacheable(original, LIVE_TOOLS) ? original : null;
}

/**
 * Runs one agent turn. `messages` is the conversation ({role: "user"|"model", text}),
 * ending with the user's question. `onStep` receives audit steps as they happen.
 * `channel` says where the turn came from ("chat" or "eval"); `withEvidence` also
 * returns the tool-result text the answer was checked against (not stored). `tier` forces
 * a model tier (router.js); `useCache` reuses and stores answers (answer-cache.js).
 */
export async function runAgent({
  messages,
  sessionId,
  company = null,
  // Which news sources this company sees (access.js); defaults to none switched off.
  access = company ? { companyId: company.company.id, disabled: [] } : ANONYMOUS,
  requestId,
  channel = "chat",
  withEvidence = false,
  tier,
  useCache = channel === "chat",
  // GETs a company backend path with the caller's own token ({ status, body }); company chats only.
  backend = null,
  // The signed-in user ({ id }, from GET /api/v1/me): their session and memories are their own.
  user = null,
  // The browser demo's own orders and playbook ({ orders, playbook }, from orders.js); demo chats only.
  demo = null,
  onStep = () => {},
}) {
  const started = Date.now();
  const companyId = company?.company.id;
  const readers = workspaceReaders(backend, company ? null : demo);
  // What this turn's tools and rules may use (gateway.js scopes, policy.js `when`).
  const session = { company, orders: readers.orders, playbook: readers.playbook, memories: [] };
  // Who this chat runs as (agents/platform.js): Agent Platform session and Memory Bank scope.
  const userKey = userKeyFor({ company, user, sessionId });

  // Asked and answered before, against the same data today: reuse that answer.
  let key = null;
  if (useCache) {
    try {
      key = answerKey({
        messages,
        companyId,
        // Remembered preferences can change an answer, so a remembered user's answers are their own.
        userKey: remembers(userKey) ? userKey : null,
        disabled: access.disabled,
        dataVersion: await dataVersion(company, access, session),
        policyVersion: POLICY_VERSION,
        models: MODELS,
        day: new Date(started).toISOString().slice(0, 10),
      });
      const original = await cachedAnswer(key, companyId);
      if (original) {
        const audit = cachedAudit(original, { sessionId, requestId, channel, companyId, question: messages.at(-1).text, startedAt: started, latencyMs: Date.now() - started });
        onStep(audit.steps[0]);
        const ref = audits.doc();
        await ref.set(audit).catch((e) => log("ERROR", "audit.write_failed", { requestId, error: String(e?.message || e) }));
        answerCache.doc(key).update({ hits: FieldValue.increment(1), lastHitAt: new Date().toISOString() }).catch(() => {});
        return { id: ref.id, ...audit };
      }
    } catch (e) {
      log("WARNING", "answer_cache.read_failed", { requestId, error: String(e?.message || e) });
    }
  }

  const route = routeQuestion(messages, { force: tier });
  // The tier answering this message: a simple-tier draft the auditor sends back is revised by the
  // analyst on the complex tier.
  let current = route.tier;
  const refs = makeRefs();
  // The stock's own categories and markets for query_inventory's filters; unread, the filters
  // are free text and the tool reports the error if it's called.
  const stock = await cached("inventory", () => list(inventory)).catch(() => []);
  const gateway = toolGateway(withStockLists(REGISTRY, stock), { refs, access, ...session }, { maxCalls: TOOL_BUDGET });
  const audit = {
    sessionId,
    requestId,
    channel,
    companyId,
    createdAt: new Date(started).toISOString(),
    question: messages.at(-1).text,
    model: TIERS[current].model,
    route: { tier: route.tier, reasons: route.reasons, agent: ANSWERING[route.tier] },
    embeddingModel: EMBED_MODEL,
    policyVersion: POLICY_VERSION,
    steps: [],
    usage: { promptTokens: 0, outputTokens: 0, thinkingTokens: 0, modelCalls: 0 },
    usageByAgent: {},
    status: "ok",
  };
  const push = (step) => {
    const s = { at: Date.now() - started, ...step };
    audit.steps.push(s);
    onStep(s);
  };
  let answer = "";
  let revised = false;
  let revision = null; // the auditor's findings, sent back as the next message
  // Normalised text the figures check accepts: the user's own messages and this turn's tool results.
  // Earlier model turns come from the client, so they can't vouch for a figure.
  let evidence = toEvidence(messages.filter((m) => m.role === "user").map((m) => m.text).join(" "));

  // Every tool call, offered or not and by any agent, runs through the gateway and is recorded.
  // With `withEvidence`, what each tool returned, in call order (for the Agent Platform eval).
  const toolResults = [];
  async function runTool(name, args = {}, agent) {
    const r = await gateway.call(name, args);
    if (r.ok) evidence += " " + toEvidence(JSON.stringify(r.output));
    if (withEvidence) toolResults.push(r.ok ? r.output : { error: r.error });
    push({
      kind: "tool",
      agent,
      name,
      args,
      latencyMs: r.latencyMs,
      ...(r.attempts > 1 ? { attempts: r.attempts } : {}),
      ...(r.ok ? r.details : { error: r.error, errorKind: r.errorKind }),
    });
    return r.ok ? { output: r.output } : { error: r.error };
  }

  // Model calls, per agent invocation: the step count (bounded; the last step must answer), when
  // the call started and which model it used.
  const calls = new Map();
  const hooks = {
    before({ context, request, tier }) {
      const key = `${context.invocationId}/${context.agentName}`;
      const answering = context.agentName === ANSWERING.simple || context.agentName === ANSWERING.complex;
      const max = answering ? MAX_STEPS : SPECIALIST_STEPS;
      const call = { step: (calls.get(key)?.step ?? -1) + 1, started: Date.now(), model: TIERS[tier].model, max };
      calls.set(key, call);
      // Past the last step (the model called a tool anyway): end that agent's work without an answer.
      if (call.step > max) {
        if (answering) audit.status = "max_steps";
        return { content: { role: "model", parts: [{ text: "" }] } };
      }
      request.model = call.model;
      request.config = { ...request.config, thinkingConfig: thinkingFor(tier) };
      if (call.step === max) request.config.toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } };
      return undefined;
    },
    after({ context, response }) {
      observe(context.agentName, calls.get(`${context.invocationId}/${context.agentName}`), response);
      return undefined;
    },
  };

  // Records each model response as a plan, report, draft or answer step. An answering agent's
  // final answer that fails the auditor goes back once (not on its last step), to the analyst.
  function observe(agent, call, res) {
    const u = res.usageMetadata || {};
    const byAgent = (audit.usageByAgent[agent] ||= { promptTokens: 0, outputTokens: 0, thinkingTokens: 0, modelCalls: 0 });
    for (const usage of [audit.usage, byAgent]) {
      usage.promptTokens += u.promptTokenCount || 0;
      usage.outputTokens += u.candidatesTokenCount || 0;
      usage.thinkingTokens += u.thoughtsTokenCount || 0;
      usage.modelCalls += 1;
    }
    const parts = res.content?.parts || [];
    const thought = parts.filter((p) => p.thought && p.text).map((p) => p.text).join("\n").trim() || undefined;
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
    const fnCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    const tokens = { prompt: u.promptTokenCount, output: u.candidatesTokenCount, thinking: u.thoughtsTokenCount };
    const attempts = res.customMetadata?.attempts;
    const meta = { agent, model: call?.model, ...(attempts > 1 ? { attempts } : {}) };
    const latencyMs = Date.now() - (call?.started ?? started);
    const final = (call?.step ?? 0) >= (call?.max ?? MAX_STEPS);

    if (fnCalls.length) {
      push({ kind: "plan", latencyMs, thought, note: text || undefined, calls: fnCalls.map((c) => ({ name: c.name, args: c.args || {} })), tokens, ...meta });
      return;
    }
    // A specialist's reply goes back to the analyst; its report step is recorded by onReport.
    if (agent !== ANSWERING.simple && agent !== ANSWERING.complex) return;
    const usedTools = audit.steps.some((s) => s.kind === "tool");
    const { problems } = review({ answer: text, retrieved: refs.all(), evidence, usedTools });
    if (problems.length && !revised && !final) {
      revised = true;
      push({ kind: "draft", latencyMs, thought, tokens, ...meta, excerpt: text.slice(0, 800) });
      push({ kind: "review", problems });
      if (current === "simple") {
        current = "complex";
        audit.route.escalated = true;
      }
      revision = `Auditor review of your draft: ${problems.join(" ")} Verify with the tools (for totals, query_inventory with the skus) or remove what you cannot support, then give the corrected final answer.`;
      return;
    }
    answer = text;
    audit.model = call?.model ?? audit.model;
    audit.route.answeredBy = agent;
    push({ kind: "answer", latencyMs, thought, tokens, ...meta, finishReason: res.finishReason });
    if (final) audit.status = "max_steps";
  }

  // What each specialist told the analyst (the analyst's tool result).
  const reports = [];
  const onReport = ({ agent, request, report, error, latencyMs }) => {
    if (withEvidence) reports.push({ agent, report: report ?? { error } });
    push({ kind: "delegate", agent, request, latencyMs, ...(error ? { error } : { excerpt: report.slice(0, 2000) }) });
  };

  const plugins = [new UnknownToolPlugin(runTool)];
  const { root, agents } = buildAssistant({ session, declarations: gateway.declarations(), runTool, plugins, hooks, onReport, routeTo: () => current });

  try {
    // What Memory Bank remembers about this user that bears on the question: preferences and
    // working context for the prompt (agents/instructions.js), never a source of figures.
    if (remembers(userKey)) {
      const searched = Date.now();
      const found = await memoryService.searchMemory({ appName: APP, userId: userKey, query: messages.at(-1).text }).catch((e) => {
        log("WARNING", "memory.search_failed", { requestId, error: String(e?.message || e) });
        return { memories: [] };
      });
      session.memories = found.memories.map((m) => m.content?.parts?.[0]?.text).filter(Boolean).slice(0, 8);
      push({ kind: "memory", count: session.memories.length, facts: session.memories, latencyMs: Date.now() - searched });
    }

    // Chats continue their Agent Platform session; evals and local runs use an in-memory one.
    const { service, session: chat, fresh } = await chatSession({ sessionId, userKey, persistent: channel === "chat" });
    const runner = new Runner({ appName: APP, agent: root, sessionService: service, plugins });
    // A new session starts from the conversation the client sent. Earlier answers lose their [n]
    // markers (refs restart each turn) but keep the titles they cited; they're attributed to the
    // agent answering now, so it reads them as its own turns.
    if (fresh)
      for (const m of messages.slice(0, -1)) {
        const text = m.role === "model" ? stripRefs(m.text) + (m.sources?.length ? `\n(Sources cited: ${m.sources.join("; ")})` : "") : m.text;
        await service.appendEvent({
          session: chat,
          event: createEvent({ author: m.role === "model" ? ANSWERING[current] : "user", content: { role: m.role, parts: [{ text }] } }),
        });
      }
    // The question, then the auditor's findings if the draft is sent back.
    let message = messages.at(-1).text;
    while (message) {
      const newMessage = { role: "user", parts: [{ text: message }] };
      for await (const event of runner.runAsync({ userId: userKey, sessionId: chat.id, newMessage })) {
        // ADK turns a model error (after our retries) into an event; it ends the turn.
        if (event.errorCode) throw Object.assign(new Error(event.errorMessage || event.errorCode), { status: Number(event.errorCode) || undefined });
      }
      [message, revision] = [revision, null];
    }
  } catch (e) {
    log("ERROR", "agent.failed", { requestId, error: String(e?.message || e), status: e?.status });
    audit.status = "error";
    audit.error = String(e?.message || e);
  }

  const retrieved = refs.all();
  const { checks, citations } = review({ answer, retrieved, evidence, usedTools: audit.steps.some((s) => s.kind === "tool") });
  // An answer that still fails the auditor after its revision is shown, flagged for a person to check.
  if (audit.status === "ok" && checks.some((c) => !c.ok)) audit.status = "needs_review";
  const flags = audit.steps.flatMap((s) => s.flags || []);
  Object.assign(audit, {
    answer: answer || (audit.status === "error" ? "" : "Sorry, I couldn't produce an answer."),
    checks,
    citations,
    retrieved,
    ...(flags.length ? { flags } : {}),
    latencyMs: Date.now() - started,
  });
  const ref = audits.doc();
  const stored = await ref.set(audit).then(
    () => true,
    (e) => log("ERROR", "audit.write_failed", { requestId, error: String(e?.message || e) }),
  );
  if (stored && key && cacheable(audit, LIVE_TOOLS))
    await answerCache
      .doc(key)
      .set({ auditId: ref.id, companyId: companyId ?? null, createdAt: audit.createdAt, expireAt: new Date(started + CACHE_TTL_MS), hits: 0 })
      .catch((e) => log("WARNING", "answer_cache.write_failed", { requestId, error: String(e?.message || e) }));
  // Memory Bank learns from the question and the answer only (no tool results), for company users.
  if (remembers(userKey) && audit.status === "ok" && channel === "chat")
    memoryService
      .addEventsToMemory({
        appName: APP,
        userId: userKey,
        events: [
          createEvent({ author: "user", content: { role: "user", parts: [{ text: audit.question }] } }),
          createEvent({ author: audit.route.answeredBy || ANSWERING[route.tier], content: { role: "model", parts: [{ text: stripRefs(audit.answer) }] } }),
        ],
      })
      .catch((e) => log("WARNING", "memory.write_failed", { requestId, error: String(e?.message || e) }));
  // The eval also gets the instruction and tool declarations the model was given.
  const trace = withEvidence ? { agents, toolResults, reports } : {};
  return { id: ref.id, ...audit, ...(withEvidence ? { evidence, trace } : {}) };
}
