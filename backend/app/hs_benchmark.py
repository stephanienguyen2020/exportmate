"""Score HS code suggestions on real customs rulings (seed_data/hs_benchmark.json).

Each ruling is a product description and the code a customs authority ruled for it. The
benchmark gives the description to the same path users get (services/hs_suggestions.py
propose_codes: tariff search, Gemini, code checks) as a company with no past orders, and
compares the 6-digit codes:

- top1: the first suggestion is the ruled code.
- top3: the ruled code is among the suggestions (up to 3).
- heading: the first suggestion is in the ruled 4-digit heading.
- retrieval: the ruled code was among the tariff lines Gemini was shown.
- nearestLine: the baseline, the single closest tariff line by embedding, no Gemini.

Every rate has a 95% Wilson interval. A failed AI call counts as wrong. The run is saved in
hs_benchmark_runs; the latest one is served at GET /api/v1/benchmarks/hs-codes.

Calls Gemini once per ruling, so run it on GCP (the Cloud Run job exportmate-backend-task with
args "python -m app.hs_benchmark"), not on a laptop. Locally, --limit runs a few.
"""

import argparse
import json
import logging
import math
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.errors import AppError
from app.core.logging import configure_logging
from app.database.models import HsBenchmarkRun
from app.database.queries import hs_codes as hs_queries
from app.database.session import open_session
from app.seed_data import load_seed_file
from app.services import hs_suggestions as hs_service

log = logging.getLogger(__name__)
DATASET_FILE = "hs_benchmark.json"
DESTINATION = "United Kingdom"  # the rulings are HMRC's
Z95 = 1.959964


def wilson(right: int, of: int) -> dict:
    """The rate with its 95% Wilson score interval (sound near 0% and 100%, unlike ±1.96·SE)."""
    if of == 0:
        return {"right": 0, "of": 0, "rate": None, "low": None, "high": None}
    p = right / of
    denominator = 1 + Z95**2 / of
    centre = (p + Z95**2 / (2 * of)) / denominator
    half = Z95 * math.sqrt(p * (1 - p) / of + Z95**2 / (4 * of**2)) / denominator
    return {
        "right": right,
        "of": of,
        "rate": round(p, 4),
        "low": round(max(0.0, centre - half), 4),
        "high": round(min(1.0, centre + half), 4),
    }


def score_case(db: Session, case: dict) -> dict:
    """One ruling through the suggestion path; nothing is saved."""
    truth = case["hsCode"]
    result = {"ref": case["ref"], "ruled": truth, "suggested": [], "error": None}
    try:
        proposal = hs_service.propose_codes(db, case["description"], DESTINATION, [])
    except AppError as error:
        result["error"] = error.code
        return result | {"retrieved": False, "nearestLine": None}
    shown = [h.code for h in proposal.headings]
    suggested = [c.hs_code for c in proposal.codes]
    return result | {
        "suggested": suggested,
        "retrieved": truth in shown,
        "nearestLine": shown[0] if proposal.heading_search == "embedding" and shown else None,
        "headingSearch": proposal.heading_search,
        "dropped": proposal.dropped,
    }


def summarise(results: list[dict]) -> dict:
    n = len(results)

    def count(test) -> int:
        return sum(1 for r in results if test(r))

    first = lambda r: r["suggested"][0] if r["suggested"] else None
    return {
        "top1": wilson(count(lambda r: first(r) == r["ruled"]), n),
        "top3": wilson(count(lambda r: r["ruled"] in r["suggested"]), n),
        "heading": wilson(count(lambda r: (first(r) or "")[:4] == r["ruled"][:4]), n),
        "retrieval": wilson(count(lambda r: r["retrieved"]), n),
        "nearestLine": wilson(count(lambda r: r["nearestLine"] == r["ruled"]), n),
        "noSuggestion": count(lambda r: not r["suggested"] and not r["error"]),
        "errors": count(lambda r: r["error"]),
    }


def _score_in_own_session(case: dict) -> dict:
    with open_session() as db:
        return score_case(db, case)


def run_benchmark(limit: int | None = None, workers: int = 8) -> HsBenchmarkRun:
    data = load_seed_file(DATASET_FILE)
    cases = data["cases"][:limit] if limit else data["cases"]
    with open_session() as db:
        total, embedded = hs_queries.count_hs_headings(db)
    if not total:
        raise SystemExit("No tariff lines: run python -m app.seed_reference_data first.")
    if embedded < total:
        log.warning("hs_benchmark.headings_not_embedded", extra={"embedded": embedded, "of": total})
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(_score_in_own_session, cases))
    settings = get_settings()
    run = HsBenchmarkRun(
        model=settings.gemini_model,
        embedding_model=settings.embedding_model,
        dataset={
            k: data[k] for k in ("source", "sourceUrl", "licence", "licenceUrl", "downloadedOn")
        }
        | {"rulingsListed": data["rulingsListed"], "sampled": len(data["cases"])},
        case_count=len(results),
        metrics=summarise(results),
        results=results,
    )
    with open_session() as db:
        db.add(run)
        db.commit()
    log.info("hs_benchmark.scored", extra={"cases": run.case_count, "metrics": run.metrics})
    return run


def latest_run(db: Session) -> HsBenchmarkRun | None:
    """The newest run over the whole set (runs with --limit are smoke tests)."""
    return db.scalar(
        select(HsBenchmarkRun)
        .where(HsBenchmarkRun.case_count == HsBenchmarkRun.dataset["sampled"].as_integer())
        .order_by(HsBenchmarkRun.created_at.desc())
        .limit(1)
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--limit", type=int, help="score only the first N rulings (a smoke test)")
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    settings = get_settings()
    configure_logging(settings.log_level, settings.resolved_log_format)
    run = run_benchmark(args.limit, args.workers)
    print(json.dumps({"id": str(run.id), "model": run.model, "metrics": run.metrics}, indent=1))


if __name__ == "__main__":
    main()
