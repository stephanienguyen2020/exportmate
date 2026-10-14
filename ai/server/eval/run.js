// Runs the golden set against the live agent (Gemini + Firestore) and scores it.
// Usage: npm run eval                       all cases
//        npm run eval -- --only=latest-scan,unknown-sku
//        npm run eval -- --judge            also grade answers with an LLM judge
//        npm run eval -- --tier=complex     every case on one model tier instead of the router's choice
//        npm run eval -- --vertex           also create an evaluation run on Agent Platform (Gen AI evaluation:
//                                           tool use, hallucination, response quality, safety; eval/vertex, needs uv)
// On GCP: gcloud run jobs execute exportmate-ai-task --args="node eval/run.js --judge" --wait
// Each run is stored in the Firestore `eval_runs` collection and compared with the
// previous run; it exits 1 if a case that passed now fails (a regression). Run it
// after every change to the prompt, model, router, embeddings, retrieval or tools.
// The answer cache is off for evals: every case is answered by the model.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, Type } from "@google/genai";
import { runAgent } from "../agent.js";
import { PROJECT, db, inventory, list } from "../db.js";
import { SCAN_MODEL, TIERS } from "../models.js";
import { summarizeAudits } from "../metrics.js";
import { POLICY_VERSION, RULES } from "../policy.js";
import { goldenCases } from "./golden.js";
import { compareRuns, scoreCase, summarizeRun } from "./score.js";

const evalRuns = db.collection("eval_runs");
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}`))?.split("=")[1] ?? (process.argv.includes(`--${name}`) ? "" : undefined);
const only = arg("only")?.split(",").filter(Boolean);
const useJudge = arg("judge") !== undefined;
const tier = arg("tier") || undefined;
const toVertex = arg("vertex") !== undefined;
if (tier && !TIERS[tier]) throw new Error(`--tier must be one of ${Object.keys(TIERS).join(", ")}`);
const JUDGE_MODEL = process.env.JUDGE_MODEL || SCAN_MODEL;
const ai = new GoogleGenAI({ vertexai: true, project: PROJECT, location: process.env.GOOGLE_CLOUD_LOCATION || "global" });

const VERDICT = {
  type: Type.OBJECT,
  properties: {
    faithfulness: { type: Type.INTEGER, description: "1-5: every claim is supported by the evidence (or is general knowledge); no invented figures" },
    relevance: { type: Type.INTEGER, description: "1-5: gives the response the rubric calls for (a clear decline is fully relevant when the rubric says to decline), otherwise answers what was asked, completely" },
    rubric: { type: Type.INTEGER, nullable: true, description: "1-5: meets the rubric; null when there is no rubric" },
    reason: { type: Type.STRING, description: "One sentence" },
  },
  required: ["faithfulness", "relevance", "reason"],
};

// LLM-as-judge: grades the answer against the evidence the agent actually saw.
async function judge(testCase, result) {
  const prompt = `You grade answers from a trade-compliance assistant. Be strict. When there is a rubric, it defines the correct behaviour (for example declining an off-topic or unsafe request): grade every score against it, not against what the user literally asked for.

CONVERSATION:
${testCase.messages.map((m) => `${m.role}: ${m.text}`).join("\n")}

EVIDENCE (the user's messages and the tool results the assistant saw):
${(result.evidence || "").slice(0, 20000)}

ANSWER:
${result.answer}

${testCase.rubric ? `RUBRIC: ${testCase.rubric}` : "RUBRIC: none (return rubric = null)"}`;
  const res = await ai.models.generateContent({
    model: JUDGE_MODEL,
    contents: prompt,
    config: { temperature: 0, responseMimeType: "application/json", responseSchema: VERDICT },
  });
  return JSON.parse(res.text || "{}");
}

// One golden case as Agent Platform agent data (types.evals.AgentData): every agent's config and
// the conversation as ADK-style events, each attributed to the agent that made it, rebuilt from the
// audit steps, the tool results and the specialists' reports.
const text = (role, author, t) => ({ author, content: { role, parts: [{ text: t }] } });
function vertexCase(c, r, s) {
  const outputs = [...r.trace.toolResults];
  const reports = [...r.trace.reports];
  const answering = r.route.agent;
  const turns = [];
  const history = c.messages.slice(0, -1);
  for (let i = 0; i < history.length; i += 2)
    turns.push({ turn_index: turns.length, events: history.slice(i, i + 2).map((m) => (m.role === "user" ? text("user", "user", m.text) : text("model", answering, m.text))) });
  const events = [text("user", "user", c.messages.at(-1).text)];
  for (const step of r.steps) {
    const author = step.agent || answering;
    if (step.kind === "plan")
      events.push({ author, content: { role: "model", parts: [...(step.note ? [{ text: step.note }] : []), ...step.calls.map((x) => ({ function_call: { name: x.name, args: x.args } }))] } });
    else if (step.kind === "tool") events.push({ author, content: { role: "user", parts: [{ function_response: { name: step.name, response: outputs.shift() } }] } });
    else if (step.kind === "delegate") {
      const { report } = reports.shift();
      events.push({ author: "analyst", content: { role: "user", parts: [{ function_response: { name: step.agent, response: typeof report === "string" ? { result: report } : report } }] } });
    } else if (step.kind === "draft") events.push(text("model", author, step.excerpt));
    else if (step.kind === "review") events.push(text("user", "auditor", `Auditor review of your draft: ${step.problems.join(" ")}`));
  }
  if (r.answer) events.push(text("model", r.route.answeredBy || answering, r.answer));
  turns.push({ turn_index: turns.length, events });
  return {
    id: c.id,
    category: c.category,
    prompt: c.messages.at(-1).text,
    agent_data: { agents: r.trace.agents, turns },
    golden_pass: s.pass,
    auditor_pass: r.status === "ok" && r.checks.every((x) => x.ok),
    tier: r.route.tier,
    escalated: Boolean(r.route.escalated),
    latency_s: r.latencyMs / 1000,
  };
}

const delegations = (r) => {
  const used = [...new Set(r.steps.filter((x) => x.kind === "delegate").map((x) => x.agent.replace("_specialist", "")))];
  return used.length ? ` (${used.join(", ")})` : "";
};

const items = await list(inventory);
const cases = goldenCases(items, { rules: RULES }).filter((c) => !only || only.includes(c.id));
const sessionId = `eval-${Date.now().toString(36)}`;
console.log(`Eval ${sessionId}: ${cases.length} cases, policy ${POLICY_VERSION}${tier ? `, all on ${tier} (${TIERS[tier].model})` : ""}${useJudge ? `, judge ${JUDGE_MODEL}` : ""}`);

const scored = [];
const results = [];
for (const c of cases) {
  const result = await runAgent({ messages: c.messages, sessionId, channel: "eval", withEvidence: true, tier });
  const verdict = useJudge ? await judge(c, result).catch((e) => ({ faithfulness: null, relevance: null, reason: `judge failed: ${e.message}` })) : null;
  const s = scoreCase(c, result, verdict);
  results.push(result);
  scored.push(s);
  const failed = s.checks.filter((x) => !x.ok);
  console.log(
    `${s.pass ? "PASS" : "FAIL"} ${c.id.padEnd(24)} ${(s.metrics.latencyMs / 1000).toFixed(1)}s ${s.metrics.toolCalls} tools, ${result.route.agent}${result.route.escalated ? "→analyst" : ""}${delegations(result)}${s.metrics.revised ? ", revised" : ""}` +
      (failed.length ? `\n     ${failed.map((x) => `${x.name}: ${x.detail}`).join("\n     ")}` : ""),
  );
}

const summary = summarizeRun(scored);
const ops = summarizeAudits(results);
const [previous] = await list(evalRuns.orderBy("runAt", "desc").limit(1));
const diff = compareRuns(previous, scored);
const saved = await evalRuns.add({
  runAt: new Date().toISOString(),
  sessionId,
  models: { simple: TIERS.simple.model, complex: TIERS.complex.model },
  tier: tier || "routed",
  policyVersion: POLICY_VERSION,
  judge: useJudge ? JUDGE_MODEL : null,
  only: only || null,
  summary,
  ops,
  regressions: diff.regressions,
  fixed: diff.fixed,
  cases: scored,
});

console.log(`\n${summary.passed}/${summary.cases} passed (${Math.round(summary.passRate * 100)}%), tool selection ${summary.toolSelection ?? "n/a"}`);
for (const [cat, c] of Object.entries(summary.byCategory)) console.log(`  ${cat.padEnd(20)} ${c.passed}/${c.cases}`);
console.log(`latency p50 ${(ops.latencyMs.p50 / 1000).toFixed(1)}s p95 ${(ops.latencyMs.p95 / 1000).toFixed(1)}s · ${ops.perAnswer.promptTokens} prompt tokens/answer · revised ${Math.round(ops.revisionRate * 100)}%`);
if (previous) {
  console.log(`vs eval_runs/${previous.id} of ${previous.runAt} (policy ${previous.policyVersion}): ${diff.regressions.length} regressions, ${diff.fixed.length} fixed`);
  if (diff.regressions.length) console.log(`  regressions: ${diff.regressions.join(", ")}`);
}
console.log(`Saved eval_runs/${saved.id} in Firestore (${PROJECT})`);

// Hands the run to eval/vertex/vertex_eval.py, which creates an evaluation run on Agent Platform:
// every case as agent data (the instruction and tools the model had, earlier turns, each function
// call and response, the auditor's send-back and the answer) plus this runner's own scores.
if (toVertex) {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, "results", `${sessionId}.vertex.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ run: { sessionId, firestoreRun: saved.id, policyVersion: POLICY_VERSION, tier: tier || "routed" }, cases: cases.map((c, n) => vertexCase(c, results[n], scored[n])) }));
  console.log(`\nCreating an Agent Platform evaluation run (${file})`);
  const py = spawnSync("uv", ["run", "--project", join(here, "vertex"), "python", join(here, "vertex", "vertex_eval.py"), file], { stdio: "inherit" });
  if (py.error || py.status !== 0) console.error(`Agent Platform evaluation failed${py.error ? `: ${py.error.message}` : ""}; the export is in ${file}`);
}
process.exit(diff.regressions.length ? 1 : 0);
