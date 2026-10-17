// Aggregate metrics over audit records (and, at the end, news-scan records), for `npm run ops`
// and the eval report:
// outcome, auditor results, latency, cost drivers, tool health, guard activity, model routing
// and the answer cache. A cached answer carries the original's steps, so tool and revision
// figures count only answers the model produced.

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
const rate = (n, total) => (total ? Math.round((n / total) * 1000) / 1000 : 0);
const countBy = (values) => values.reduce((m, v) => ((m[v] = (m[v] || 0) + 1), m), {});

/** Summarises audits (as stored in Firestore). */
export function summarizeAudits(audits) {
  const n = audits.length;
  const latencies = audits.map((a) => a.latencyMs || 0).sort((a, b) => a - b);
  const fresh = audits.filter((a) => !a.cache);
  const toolSteps = fresh.flatMap((a) => (a.steps || []).filter((s) => s.kind === "tool"));
  const tools = {};
  for (const s of toolSteps) {
    const t = (tools[s.name] ||= { calls: 0, errors: 0, retried: 0, errorKinds: {} });
    t.calls++;
    if (s.attempts > 1) t.retried++;
    if (s.error) {
      t.errors++;
      t.errorKinds[s.errorKind || "failed"] = (t.errorKinds[s.errorKind || "failed"] || 0) + 1;
    }
  }
  const checks = {};
  for (const a of audits)
    for (const c of a.checks || []) {
      const k = (checks[c.name] ||= { passed: 0, failed: 0 });
      c.ok ? k.passed++ : k.failed++;
    }
  const sum = (f) => audits.reduce((s, a) => s + (f(a) || 0), 0);
  return {
    audits: n,
    status: countBy(audits.map((a) => a.status || "ok")),
    passRate: rate(audits.filter((a) => a.status === "ok" && (a.checks || []).every((c) => c.ok)).length, n),
    revisionRate: rate(fresh.filter((a) => (a.steps || []).some((s) => s.kind === "review")).length, fresh.length),
    checks,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies.at(-1) || 0 },
    perAnswer: {
      modelCalls: rate(sum((a) => a.usage?.modelCalls), n),
      promptTokens: Math.round(sum((a) => a.usage?.promptTokens) / (n || 1)),
      outputTokens: Math.round(sum((a) => a.usage?.outputTokens) / (n || 1)),
      toolCalls: rate(toolSteps.length, n),
      citations: rate(sum((a) => a.citations?.length), n),
    },
    toolErrorRate: rate(toolSteps.filter((s) => s.error).length, toolSteps.length),
    tools,
    withheldPassages: sum((a) => a.flags?.length),
    policyVersions: countBy(audits.map((a) => a.policyVersion || "unversioned")),
    models: countBy(audits.map((a) => a.model || "unknown")),
    tiers: countBy(fresh.map((a) => a.route?.tier || "unrouted")),
    escalationRate: rate(fresh.filter((a) => a.route?.escalated).length, fresh.filter((a) => a.route?.tier === "simple").length),
    cacheHitRate: rate(n - fresh.length, n),
  };
}

/** Summarises news-scan records (Firestore `scans`): outcome, what was read and raised, Gemini
 * batches lost, RAG imports that failed, feeds that failed and scans stuck running. */
export function summarizeScans(scans, now = Date.now()) {
  const sorted = [...scans].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const finished = sorted.filter((s) => s.finishedAt);
  const durations = finished.map((s) => Date.parse(s.finishedAt) - Date.parse(s.startedAt)).filter(Number.isFinite).sort((a, b) => a - b);
  const sum = (f) => sorted.reduce((t, s) => t + (f(s) || 0), 0);
  const feeds = {};
  for (const s of sorted)
    for (const src of s.sources || []) {
      const f = (feeds[src.name || src.id] ||= { reads: 0, failed: 0 });
      f.reads++;
      if (src.ok === false) f.failed++;
    }
  const last = sorted.at(-1);
  return {
    scans: sorted.length,
    status: countBy(sorted.map((s) => s.status || "unknown")),
    triggers: countBy(sorted.map((s) => s.trigger || "unknown")),
    // A scan still "running" a quarter of an hour after it started died without recording an end.
    stuck: sorted.filter((s) => s.status === "running" && now - Date.parse(s.startedAt) > 15 * 60_000).length,
    articles: {
      fetched: sum((s) => s.articlesFetched),
      analysed: sum((s) => s.articlesAnalysed),
      failed: sum((s) => s.articlesFailed) + sum((s) => s.companyArticlesFailed),
      withheld: sum((s) => s.articlesWithheld),
      unscreened: sum((s) => s.articlesUnscreened),
    },
    alerts: sum((s) => s.impactsFound) + sum((s) => Object.values(s.companyImpacts || {}).reduce((t, n) => t + n, 0)),
    indexed: sum((s) => s.indexed),
    indexFailures: sorted.filter((s) => s.indexError).length,
    durationMs: { p50: percentile(durations, 50), max: durations.at(-1) || 0 },
    failingFeeds: Object.fromEntries(Object.entries(feeds).filter(([, f]) => f.failed)),
    last: last ? { startedAt: last.startedAt, status: last.status, trigger: last.trigger } : null,
  };
}
