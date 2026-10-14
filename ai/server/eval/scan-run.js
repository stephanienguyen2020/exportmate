// Runs the news scan's relevance judgment (Gemini + the code checks after it) over the
// labeled articles in scan-golden.js and scores it. No feeds are read and nothing is
// written to articles, impacts or the search index.
// Usage: npm run eval:scan                          all cases
//        npm run eval:scan -- --only=cocoa-eudr,us-232-cabinets
//        npm run eval:scan -- --repeat=3           run each case 3 times; a case passes only if it always passes
// On GCP: gcloud run jobs execute exportmate-ai-task --args="node eval/scan-run.js" --wait
// Each run is stored in the Firestore `scan_eval_runs` collection and compared with the
// last run without model errors; it exits 1 if a case that passed now fails (a regression)
// or if any model call failed. Run it after every change to the scan's RULES, schema,
// model or relevance.js.
import { PROJECT, db, inventory, list } from "../db.js";
import { BATCH, MODEL, SCAN_POLICY_VERSION, assess } from "../scan.js";
import { decide } from "../relevance.js";
import { scanCases } from "./scan-golden.js";
import { inBatches, mergeRepeats, scoreScanCases, summarizeScanRun } from "./scan-score.js";
import { compareRuns } from "./score.js";

const scanEvalRuns = db.collection("scan_eval_runs");
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const only = arg("only")?.split(",").filter(Boolean);
const repeat = Math.max(1, Number(arg("repeat")) || 1);

const items = await list(inventory);
if (!items.length) throw new Error(`No stock in ${PROJECT}; run npm run seed first`);
const bySku = new Map(items.map((i) => [i.sku, i]));
const cases = scanCases(items).filter((c) => !only || only.includes(c.id));
console.log(`Scan eval: ${cases.length} articles, ${repeat} run(s), model ${MODEL}, scan policy ${SCAN_POLICY_VERSION}`);

async function runOnce() {
  const outcomes = new Map();
  for (const batch of inBatches(cases, BATCH)) {
    let results;
    try {
      results = await assess(batch.map((c) => c.article), items);
    } catch (e) {
      batch.forEach((c) => outcomes.set(c.id, { error: String(e?.message || e) }));
      continue;
    }
    const byIndex = new Map(results.map((r) => [r.index, r]));
    batch.forEach((c, n) => {
      const r = byIndex.get(n);
      if (!r) return;
      const d = decide(c.article, r, n, bySku);
      outcomes.set(c.id, {
        relevant: d.relevant,
        modelRelevant: Boolean(r.relevant),
        affected: d.affected.map((x) => x.sku),
        severity: r.severity ?? null,
        direction: r.direction ?? null,
        duplicate: d.duplicate,
        otherCommodity: d.otherCommodity,
        headline: r.headline ?? null,
        why: r.why ?? null,
      });
    });
  }
  return scoreScanCases(cases, outcomes);
}

const runs = [];
for (let i = 0; i < repeat; i++) runs.push(await runOnce());
const scored = mergeRepeats(runs);
const summaries = runs.map((r) => summarizeScanRun(cases, r));

for (const s of scored) {
  const failed = s.checks.filter((x) => !x.ok);
  console.log(
    `${s.pass ? "PASS" : "FAIL"} ${s.id.padEnd(30)} ${s.outcome.relevant ? `alert: ${s.outcome.severity}/${s.outcome.direction} ${s.outcome.affected.join(" ")}` : "no alert"}` +
      (repeat > 1 ? ` (${s.passes}/${s.runs}${s.stable ? "" : ", unstable"})` : "") +
      (failed.length ? `\n     ${failed.map((x) => `${x.name}: ${x.detail}`).join("\n     ")}` : ""),
  );
}

const pct = (x) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);
console.log(`\n${scored.filter((s) => s.pass).length}/${scored.length} passed${repeat > 1 ? ` every run, ${scored.filter((s) => s.stable).length}/${scored.length} stable` : ""}`);
summaries.forEach((m, i) =>
  console.log(
    `${repeat > 1 ? `run ${i + 1}: ` : ""}relevance precision ${pct(m.relevance.precision)} recall ${pct(m.relevance.recall)} (fp ${m.relevance.fp}, fn ${m.relevance.fn}) · SKUs precision ${pct(m.skus.precision)} recall ${pct(m.skus.recall)} · severity ${pct(m.severityAgreement)} · direction ${pct(m.directionAgreement)} · dropped by code: ${m.overridden.otherCommodity} other commodity, ${m.overridden.noSkuInStock} no SKU${m.errors ? ` · ${m.errors} errors` : ""}`,
  ),
);

// Compare with the last run whose model calls all succeeded; a run with errors measured nothing.
const recent = await list(scanEvalRuns.orderBy("runAt", "desc").limit(20));
const previous = recent.find((r) => (r.summaries || []).every((m) => !m.errors));
const diff = compareRuns(previous, scored);
const saved = await scanEvalRuns.add({
  runAt: new Date().toISOString(),
  model: MODEL,
  policyVersion: SCAN_POLICY_VERSION,
  only: only || null,
  repeat,
  summaries,
  regressions: diff.regressions,
  fixed: diff.fixed,
  cases: scored,
});
if (previous) {
  console.log(`vs scan_eval_runs/${previous.id} of ${previous.runAt} (policy ${previous.policyVersion}): ${diff.regressions.length} regressions, ${diff.fixed.length} fixed`);
  if (diff.regressions.length) console.log(`  regressions: ${diff.regressions.join(", ")}`);
}
console.log(`Saved scan_eval_runs/${saved.id} in Firestore (${PROJECT})`);
const errors = summaries.reduce((n, m) => n + m.errors, 0);
if (errors) console.log(`${errors} assessments failed: this run is not a measurement and later runs won't compare with it`);
process.exit(diff.regressions.length || errors ? 1 : 0);
