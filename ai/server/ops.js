// AgentOps report over recent chat audits: is the assistant healthy, and if not, why?
// Usage: npm run ops                 (last 7 days of user chats)
//        npm run ops -- --days=1 --eval   (include eval runs) --json (raw summary)
//        gcloud run jobs execute exportmate-ai-task --region asia-southeast1 --wait --args="node ops.js --days=1"
import { audits } from "./agent.js";
import { list } from "./db.js";
import { summarizeAudits } from "./metrics.js";

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}`));
const days = Number(arg("days")?.split("=")[1] || 7);
const since = new Date(Date.now() - days * 86_400_000).toISOString();

const rows = (await list(audits.where("createdAt", ">=", since).limit(2000))).filter((a) => arg("eval") || (a.channel || "chat") === "chat");
const s = summarizeAudits(rows);

if (arg("json")) {
  console.log(JSON.stringify(s, null, 2));
} else {
  const pct = (r) => `${Math.round(r * 100)}%`;
  console.log(`Assistant, last ${days} day(s): ${s.audits} answers`);
  console.log(`  status         ${Object.entries(s.status).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  console.log(`  passed checks  ${pct(s.passRate)}   revised by auditor ${pct(s.revisionRate)}`);
  for (const [name, c] of Object.entries(s.checks)) console.log(`    ${c.failed ? "✗" : "✓"} ${name}: ${c.failed} failed of ${c.passed + c.failed}`);
  console.log(`  latency        p50 ${(s.latencyMs.p50 / 1000).toFixed(1)}s   p95 ${(s.latencyMs.p95 / 1000).toFixed(1)}s   max ${(s.latencyMs.max / 1000).toFixed(1)}s`);
  console.log(
    `  per answer     ${s.perAnswer.modelCalls} model calls, ${s.perAnswer.toolCalls} tool calls, ${s.perAnswer.promptTokens} prompt + ${s.perAnswer.outputTokens} output tokens, ${s.perAnswer.citations} citations`,
  );
  console.log(`  tool errors    ${pct(s.toolErrorRate)}`);
  for (const [name, t] of Object.entries(s.tools))
    console.log(`    ${name.padEnd(20)} ${t.calls} calls, ${t.errors} errors${t.errors ? ` (${Object.entries(t.errorKinds).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}, ${t.retried} retried`);
  console.log(`  guard          ${s.withheldPassages} third-party passages withheld`);
  console.log(`  policy         ${Object.entries(s.policyVersions).map(([k, v]) => `${k} (${v})`).join(", ")}`);
  console.log(`  models         ${Object.entries(s.models).map(([k, v]) => `${k} (${v})`).join(", ")}`);
}
