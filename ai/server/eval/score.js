// Scores one golden case against the agent's result (its audit record): the final
// answer (contains / must not say), the trajectory (which tools, with which
// arguments, how many steps and errors) and the auditor's own checks. Pure, so the
// scoring itself is unit-tested.

const numeric = (s) => /^\d+(\.\d+)?$/.test(s);
const plain = (text) => String(text).replace(/(\d),(?=\d{3})/g, "$1");
// A number matches as a whole number; text matches case-insensitively.
const found = (answer, needle) =>
  numeric(needle)
    ? new RegExp(`(^|[^\\d.])${needle.replace(".", "\\.")}(?![\\d])`).test(plain(answer))
    : answer.toLowerCase().includes(String(needle).toLowerCase());

function argMatches(actual, expected) {
  return Object.entries(expected).every(([k, want]) => {
    const got = actual?.[k];
    if (want === "*") return got != null && !(Array.isArray(got) && !got.length) && got !== "";
    if (Array.isArray(want)) return Array.isArray(got) && want.every((w) => got.some((g) => String(g).toLowerCase() === String(w).toLowerCase()));
    if (typeof want === "string") return typeof got === "string" && got.toLowerCase() === want.toLowerCase();
    return got === want;
  });
}

/** Returns { id, category, pass, checks: [{ name, ok, detail }], metrics }. */
export function scoreCase(testCase, result, verdict) {
  const e = testCase.expect || {};
  const answer = result.answer || "";
  const toolSteps = (result.steps || []).filter((s) => s.kind === "tool");
  const called = [...new Set(toolSteps.map((s) => s.name))];
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  check("Answered", result.status !== "error" && answer.trim().length > 0, `status ${result.status}`);
  const failed = (result.checks || []).filter((c) => !c.ok);
  check("Auditor checks pass", result.status === "ok" && !failed.length, failed.map((c) => `${c.name}: ${c.detail}`).join("; ") || "all passed");
  if (e.tools) {
    const missing = e.tools.filter((t) => !called.includes(t));
    check("Expected tools called", !missing.length, missing.length ? `missing ${missing.join(", ")} (called ${called.join(", ") || "none"})` : called.join(", "));
  }
  if (e.noTools) check("No tools needed", !called.length, called.length ? `called ${called.join(", ")}` : "none called");
  for (const [tool, want] of Object.entries(e.args || {})) {
    const ok = toolSteps.some((s) => s.name === tool && argMatches(s.args, want));
    check(`${tool} arguments`, ok, ok ? JSON.stringify(want) : `no ${tool} call with ${JSON.stringify(want)}`);
  }
  for (const [tool, keys] of Object.entries(e.forbidArgs || {})) {
    const bad = toolSteps.filter((s) => s.name === tool && keys.some((k) => s.args?.[k] != null));
    check(`${tool} without ${keys.join("/")}`, !bad.length, bad.length ? JSON.stringify(bad[0].args) : "ok");
  }
  if (e.contains?.length) {
    const missing = e.contains.filter((n) => !found(answer, n));
    check("Contains expected facts", !missing.length, missing.length ? `missing ${missing.join(", ")}` : e.contains.join(", "));
  }
  if (e.containsAny?.length) check("Contains one of", e.containsAny.some((n) => found(answer, n)), e.containsAny.join(" | "));
  if (e.notContains?.length) {
    const present = e.notContains.filter((n) => found(answer, n));
    check("Says nothing it must not", !present.length, present.length ? `contains ${present.join(", ")}` : "ok");
  }
  if (e.pattern) check("Matches pattern", new RegExp(e.pattern, "i").test(answer), e.pattern);
  if (verdict) {
    const scores = [verdict.faithfulness, verdict.relevance, verdict.rubric].filter((s) => s != null);
    check("Judge", scores.every((s) => s >= 4), `faithfulness ${verdict.faithfulness}, relevance ${verdict.relevance}${verdict.rubric != null ? `, rubric ${verdict.rubric}` : ""}: ${verdict.reason}`);
  }

  return {
    id: testCase.id,
    category: testCase.category,
    pass: checks.every((c) => c.ok),
    checks,
    metrics: {
      status: result.status,
      latencyMs: result.latencyMs,
      modelCalls: result.usage?.modelCalls,
      toolCalls: toolSteps.length,
      toolErrors: toolSteps.filter((s) => s.error).length,
      revised: (result.steps || []).some((s) => s.kind === "review"),
      tools: called,
    },
    answer,
    auditId: result.id,
  };
}

/** Pass rates overall and by category. */
export function summarizeRun(scored) {
  const byCategory = {};
  for (const s of scored) {
    const c = (byCategory[s.category] ||= { cases: 0, passed: 0 });
    c.cases++;
    if (s.pass) c.passed++;
  }
  const withTools = scored.filter((s) => s.checks.some((c) => c.name === "Expected tools called"));
  return {
    cases: scored.length,
    passed: scored.filter((s) => s.pass).length,
    passRate: scored.length ? Math.round((scored.filter((s) => s.pass).length / scored.length) * 1000) / 1000 : 0,
    toolSelection: withTools.length
      ? Math.round((withTools.filter((s) => s.checks.find((c) => c.name === "Expected tools called").ok).length / withTools.length) * 1000) / 1000
      : null,
    byCategory,
  };
}

/** Cases that passed in the previous run and fail now (regressions), and the reverse. */
export function compareRuns(previous, current) {
  const before = new Map((previous?.cases || []).map((c) => [c.id, c.pass]));
  return {
    regressions: current.filter((c) => before.get(c.id) === true && !c.pass).map((c) => c.id),
    fixed: current.filter((c) => before.get(c.id) === false && c.pass).map((c) => c.id),
  };
}
