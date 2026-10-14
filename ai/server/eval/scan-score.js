// Scores the news scan against its labeled articles (scan-golden.js): whether each
// article was kept, which SKUs the alert names, its severity and direction, and whether
// a repeated report of one event was kept once. Pure, so the scoring is unit-tested.

const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);

/** Splits cases into batches of `size`, keeping the reports of one event together. */
export function inBatches(cases, size) {
  const units = [];
  const byEvent = new Map();
  for (const c of cases) {
    if (!c.event) units.push([c]);
    else if (byEvent.has(c.event)) byEvent.get(c.event).push(c);
    else units.push(byEvent.set(c.event, [c]).get(c.event));
  }
  const batches = [];
  for (const unit of units) {
    const last = batches.at(-1);
    if (last && last.length + unit.length <= size) last.push(...unit);
    else batches.push([...unit]);
  }
  return batches;
}

/** Why an article the model called relevant was not kept. */
function droppedBecause(o) {
  if (!o.modelRelevant || o.relevant) return null;
  if (o.otherCommodity) return "other commodity";
  if (o.duplicate) return "repeat of another article";
  return "no SKU in stock";
}

/**
 * Scores each case from `outcomes` (case id -> { relevant, modelRelevant, affected: [sku],
 * severity, direction, duplicate, otherCommodity, error }). Returns [{ id, category, pass, checks, outcome }].
 */
export function scoreScanCases(cases, outcomes) {
  return cases.map((c) => {
    const e = c.expect;
    const o = outcomes.get(c.id) || { error: "no assessment returned" };
    const checks = [];
    const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

    check("Assessed", !o.error, o.error || "ok");
    if (c.event) {
      const kept = cases.filter((x) => x.event === c.event && outcomes.get(x.id)?.relevant).map((x) => x.id);
      check("Event kept once", kept.length === 1, kept.length ? `kept ${kept.join(", ")}` : "no report kept");
    } else {
      const why = droppedBecause(o);
      check("Relevance", Boolean(o.relevant) === e.relevant, `expected ${e.relevant ? "relevant" : "not relevant"}, got ${o.relevant ? "relevant" : "not relevant"}${why ? ` (model said relevant; dropped: ${why})` : ""}`);
    }
    if (e.relevant && o.relevant) {
      const named = o.affected || [];
      const missing = (e.skus || []).filter((s) => !named.includes(s));
      const allowed = new Set([...(e.skus || []), ...(e.allowed || [])]);
      const extra = named.filter((s) => !allowed.has(s));
      check("Names the affected SKUs", !missing.length, missing.length ? `missing ${missing.join(", ")}` : named.join(", "));
      check("Names no unrelated SKUs", !extra.length, extra.length ? `also named ${extra.join(", ")}` : "ok");
      if (e.severity) check("Severity", e.severity.includes(o.severity), `${o.severity} (expected ${e.severity.join(" or ")})`);
      if (e.direction) check("Direction", e.direction.includes(o.direction), `${o.direction} (expected ${e.direction.join(" or ")})`);
    }
    return { id: c.id, category: c.category, pass: checks.every((x) => x.ok), checks, outcome: o };
  });
}

/**
 * Pass rates plus the scan's quality figures: relevance precision/recall (an event's
 * reports count once), SKU precision/recall over alerts that should exist and do,
 * severity and direction agreement, and how often the code checks overrode the model.
 */
export function summarizeScanRun(cases, scored) {
  const byId = new Map(scored.map((s) => [s.id, s.outcome]));
  const byCategory = {};
  for (const s of scored) {
    const c = (byCategory[s.category] ||= { cases: 0, passed: 0 });
    c.cases++;
    if (s.pass) c.passed++;
  }

  const units = new Map();
  for (const c of cases) units.set(c.event || c.id, [...(units.get(c.event || c.id) || []), c]);
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const members of units.values()) {
    const expected = members[0].expect.relevant;
    const got = members.some((c) => byId.get(c.id)?.relevant);
    if (expected && got) tp++;
    else if (got) fp++;
    else if (expected) fn++;
    else tn++;
  }
  const precision = rate(tp, tp + fp);
  const recall = rate(tp, tp + fn);

  let named = 0, namedAllowed = 0, required = 0, requiredNamed = 0;
  const agree = { severity: [0, 0], direction: [0, 0] };
  for (const c of cases) {
    const o = byId.get(c.id);
    if (!c.expect.relevant || !o?.relevant) continue;
    const allowed = new Set([...(c.expect.skus || []), ...(c.expect.allowed || [])]);
    named += o.affected.length;
    namedAllowed += o.affected.filter((s) => allowed.has(s)).length;
    required += (c.expect.skus || []).length;
    requiredNamed += (c.expect.skus || []).filter((s) => o.affected.includes(s)).length;
    for (const k of ["severity", "direction"])
      if (c.expect[k]) {
        agree[k][1]++;
        if (c.expect[k].includes(o[k])) agree[k][0]++;
      }
  }
  const outcomes = [...byId.values()];
  return {
    cases: scored.length,
    passed: scored.filter((s) => s.pass).length,
    passRate: rate(scored.filter((s) => s.pass).length, scored.length) ?? 0,
    relevance: { tp, fp, fn, tn, precision, recall, f1: precision != null && recall != null && precision + recall ? Math.round(((2 * precision * recall) / (precision + recall)) * 1000) / 1000 : null },
    skus: { precision: rate(namedAllowed, named), recall: rate(requiredNamed, required) },
    severityAgreement: rate(...agree.severity),
    directionAgreement: rate(...agree.direction),
    overridden: {
      otherCommodity: outcomes.filter((o) => o?.modelRelevant && o.otherCommodity).length,
      noSkuInStock: outcomes.filter((o) => o?.modelRelevant && !o.relevant && !o.otherCommodity && !o.duplicate).length,
    },
    errors: outcomes.filter((o) => o?.error).length,
    byCategory,
  };
}

/** Over repeated runs of the same cases: a case passes only if it passed every time. */
export function mergeRepeats(runs) {
  const [first] = runs;
  return first.map((s, n) => {
    const reps = runs.map((r) => r[n]);
    const failed = reps.find((r) => !r.pass);
    return {
      ...(failed || s),
      pass: !failed,
      passes: reps.filter((r) => r.pass).length,
      runs: reps.length,
      stable: reps.every((r) => Boolean(r.outcome.relevant) === Boolean(s.outcome.relevant)),
    };
  });
}
