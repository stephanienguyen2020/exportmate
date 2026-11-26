"""Runs the news scan's relevance judgment (Gemini and the code checks after it) over the labeled
articles in services/news_scan_exam.py and scores it. No feeds are read and nothing is written
to articles, alerts or the search index.

  uv run python -m app.news_scan_eval                        all cases
  uv run python -m app.news_scan_eval --only=cocoa-eudr,us-232-cabinets
  uv run python -m app.news_scan_eval --repeat=3             a case passes only if it always does
On GCP: gcloud run jobs execute exportmate-backend-task --args="python -m app.news_scan_eval" --wait

Needs GOOGLE_CLOUD_PROJECT (the sample stock and the runs are in its Firestore) and Google
credentials. Each run is stored in Firestore `scan_eval_runs` and compared with the last run
without model errors; it exits 1 if a case that passed now fails or any model call failed.
Run it after every change to the scan's RULES, schema, model or decide()."""

import argparse
import sys
from datetime import UTC, date, datetime

from app.core.config import get_settings
from app.core.errors import AppError
from app.database.news_store import get_news_store
from app.services.news_scan import BATCH, assess, error_text
from app.services.news_scan_exam import (
    compare_runs,
    in_batches,
    merge_repeats,
    scan_cases,
    score_scan_cases,
    summarize_scan_run,
)
from app.services.news_scan_rules import (
    SAMPLE_STOCK_PROFILE,
    SCAN_POLICY_VERSION,
    clean_mentions,
    decide,
)


def _pct(x: float | None) -> str:
    return "n/a" if x is None else f"{round(x * 100)}%"


def run_once(cases: list[dict], items: list[dict]) -> list[dict]:
    by_sku = {i["sku"]: i for i in items}
    outcomes: dict[str, dict] = {}
    for batch in in_batches(cases, BATCH):
        try:
            results = assess([c["article"] for c in batch], items, SAMPLE_STOCK_PROFILE)
        except AppError as error:
            for c in batch:
                outcomes[c["id"]] = {"error": error_text(error)}
            continue
        by_index = {r["index"]: r for r in results}
        for n, case in enumerate(batch):
            r = by_index.get(n)
            if r is None:
                continue
            relevant, affected, duplicate, other = decide(
                case["article"], r, n, by_sku, SAMPLE_STOCK_PROFILE
            )
            outcomes[case["id"]] = {
                "relevant": relevant,
                "modelRelevant": bool(r.get("relevant")),
                "affected": [x["sku"] for x in affected],
                "severity": r.get("severity"),
                "direction": r.get("direction"),
                "duplicate": duplicate,
                "otherCommodity": other,
                "headline": r.get("headline"),
                "why": r.get("why"),
                "mentions": clean_mentions(r.get("mentions")),
            }
    return score_scan_cases(cases, outcomes)


def main() -> None:
    parser = argparse.ArgumentParser(description="Score the news scan on labeled articles.")
    parser.add_argument("--only", default="", help="comma-separated case ids")
    parser.add_argument("--repeat", type=int, default=1)
    args = parser.parse_args()
    only = [i for i in args.only.split(",") if i]
    repeat = max(1, args.repeat)
    settings = get_settings()
    store = get_news_store()

    items = store.list_sample_stock()
    if not items:
        sys.exit(f"No sample stock in {settings.google_cloud_project}; seed the AI service first")
    cases = [c for c in scan_cases(items, date.today()) if not only or c["id"] in only]
    print(
        f"Scan eval: {len(cases)} articles, {repeat} run(s), model {settings.gemini_model}, "
        f"scan policy {SCAN_POLICY_VERSION}"
    )
    runs = [run_once(cases, items) for _ in range(repeat)]
    scored = merge_repeats(runs)
    summaries = [summarize_scan_run(cases, r) for r in runs]

    for s in scored:
        o = s["outcome"]
        verdict = (
            f"alert: {o.get('severity')}/{o.get('direction')} {' '.join(o.get('affected', []))}"
            if o.get("relevant")
            else "no alert"
        )
        line = f"{'PASS' if s['pass'] else 'FAIL'} {s['id']:<30} {verdict}"
        if repeat > 1:
            line += f" ({s['passes']}/{s['runs']}{'' if s['stable'] else ', unstable'})"
        for c in s["checks"]:
            if not c["ok"]:
                line += f"\n     {c['name']}: {c['detail']}"
        if s["mentions"] and s["mentions"]["missing"]:
            line += f"\n     mentions missed: {', '.join(s['mentions']['missing'])}"
        print(line)

    passed = sum(1 for s in scored if s["pass"])
    stable = f", {sum(1 for s in scored if s['stable'])}/{len(scored)} stable" if repeat > 1 else ""
    print(f"\n{passed}/{len(scored)} passed{' every run' if repeat > 1 else ''}{stable}")
    for n, m in enumerate(summaries):
        print(
            f"{f'run {n + 1}: ' if repeat > 1 else ''}"
            f"relevance precision {_pct(m['relevance']['precision'])} recall "
            f"{_pct(m['relevance']['recall'])} (fp {m['relevance']['fp']}, fn {m['relevance']['fn']})"
            f" · SKUs precision {_pct(m['skus']['precision'])} recall {_pct(m['skus']['recall'])}"
            f" · severity {_pct(m['severityAgreement'])} · direction {_pct(m['directionAgreement'])}"
            f" · mentions recall {_pct(m['mentions']['recall'])} (extra origins "
            f"{m['mentions']['extraOrigins']}) · dropped by code: "
            f"{m['overridden']['otherCommodity']} other commodity, "
            f"{m['overridden']['noSkuInStock']} no SKU"
            + (f" · {m['errors']} errors" if m["errors"] else "")
        )

    # Compare with the last run whose model calls all succeeded; one with errors measured nothing.
    recent = store.list_scan_eval_runs(20)
    previous = next(
        (r for r in recent if all(not m.get("errors") for m in r.get("summaries", []))), None
    )
    diff = compare_runs(previous, scored)
    saved = store.add_scan_eval_run(
        {
            "runAt": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "model": settings.gemini_model,
            "policyVersion": SCAN_POLICY_VERSION,
            "only": only or None,
            "repeat": repeat,
            "summaries": summaries,
            "regressions": diff["regressions"],
            "fixed": diff["fixed"],
            "cases": scored,
        }
    )
    if previous:
        print(
            f"vs scan_eval_runs/{previous['id']} of {previous['runAt']} (policy "
            f"{previous.get('policyVersion')}): {len(diff['regressions'])} regressions, "
            f"{len(diff['fixed'])} fixed"
        )
        if diff["regressions"]:
            print(f"  regressions: {', '.join(diff['regressions'])}")
    print(f"Saved scan_eval_runs/{saved} in Firestore ({settings.google_cloud_project})")
    errors = sum(m["errors"] for m in summaries)
    if errors:
        print(f"{errors} assessments failed: this run is not a measurement")
    sys.exit(1 if diff["regressions"] or errors else 0)


if __name__ == "__main__":
    main()
