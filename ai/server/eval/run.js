// Runs the golden set against the live agent (Gemini + Firestore) and scores it.
// Usage: npm run eval                       all cases
//        npm run eval -- --only=latest-scan,unknown-sku
//        npm run eval -- --judge            also grade answers with an LLM judge
// On GCP: gcloud run jobs execute exportmate-ai-task --args="node eval/run.js --judge" --wait
// Each run is stored in the Firestore `eval_runs` collection and compared with the
// previous run; it exits 1 if a case that passed now fails (a regression). Run it
// after every change to the prompt, model, embeddings, retrieval or tools.
import { GoogleGenAI, Type } from "@google/genai";
import { runAgent } from "../agent.js";
import { PROJECT, db, inventory, list } from "../db.js";
import { summarizeAudits } from "../metrics.js";
import { POLICY_VERSION, RULES } from "../policy.js";
import { goldenCases } from "./golden.js";
import { compareRuns, scoreCase, summarizeRun } from "./score.js";

const evalRuns = db.collection("eval_runs");
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}`))?.split("=")[1] ?? (process.argv.includes(`--${name}`) ? "" : undefined);
const only = arg("only")?.split(",").filter(Boolean);
const useJudge = arg("judge") !== undefined;
const JUDGE_MODEL = process.env.JUDGE_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ai = new GoogleGenAI({ vertexai: true, project: PROJECT, location: process.env.GOOGLE_CLOUD_LOCATION || "global" });

const VERDICT = {
  type: Type.OBJECT,
  properties: {
    faithfulness: { type: Type.INTEGER, description: "1-5: every claim is supported by the evidence (or is general knowledge); no invented figures" },
    relevance: { type: Type.INTEGER, description: "1-5: answers what was asked, completely" },
    rubric: { type: Type.INTEGER, nullable: true, description: "1-5: meets the rubric; null when there is no rubric" },
    reason: { type: Type.STRING, description: "One sentence" },
  },
  required: ["faithfulness", "relevance", "reason"],
};

// LLM-as-judge: grades the answer against the evidence the agent actually saw.
async function judge(testCase, result) {
  const prompt = `You grade answers from a trade-compliance assistant. Be strict.

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

const items = await list(inventory);
const cases = goldenCases(items, { rules: RULES }).filter((c) => !only || only.includes(c.id));
const sessionId = `eval-${Date.now().toString(36)}`;
console.log(`Eval ${sessionId}: ${cases.length} cases, policy ${POLICY_VERSION}${useJudge ? `, judge ${JUDGE_MODEL}` : ""}`);

const scored = [];
const results = [];
for (const c of cases) {
  const result = await runAgent({ messages: c.messages, sessionId, channel: "eval", withEvidence: true });
  const verdict = useJudge ? await judge(c, result).catch((e) => ({ faithfulness: null, relevance: null, reason: `judge failed: ${e.message}` })) : null;
  const s = scoreCase(c, result, verdict);
  results.push(result);
  scored.push(s);
  const failed = s.checks.filter((x) => !x.ok);
  console.log(
    `${s.pass ? "PASS" : "FAIL"} ${c.id.padEnd(24)} ${(s.metrics.latencyMs / 1000).toFixed(1)}s ${s.metrics.toolCalls} tools${s.metrics.revised ? ", revised" : ""}` +
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
  model: results[0]?.model,
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
process.exit(diff.regressions.length ? 1 : 0);
