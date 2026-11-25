"""Measured accuracy, public: what the product says about itself comes from a scored run."""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.errors import not_found_error
from app.database.session import get_db
from app.hs_benchmark import latest_run
from app.schemas.benchmarks import HsBenchmarkMetricsOut, HsBenchmarkOut
from app.schemas.common import SuccessResponse, success_response

router = APIRouter(tags=["benchmarks"])
Db = Annotated[Session, Depends(get_db)]


@router.get(
    "/benchmarks/hs-codes",
    response_model=SuccessResponse[HsBenchmarkOut],
    tags=["public"],  # in the public spec (api/public.py)
    responses={404: {"description": "No full benchmark run yet."}},
)
def hs_code_benchmark(db: Db):
    """The latest full run of HS code suggestions on held-out customs rulings (no sign-in).
    Rates only; the per-ruling results stay in the database."""
    run = latest_run(db)
    if not run:
        raise not_found_error("Benchmark run")
    return success_response(
        HsBenchmarkOut(
            created_at=run.created_at,
            model=run.model,
            embedding_model=run.embedding_model,
            dataset=run.dataset,
            case_count=run.case_count,
            metrics=HsBenchmarkMetricsOut.model_validate(
                {
                    "top1": run.metrics["top1"],
                    "top3": run.metrics["top3"],
                    "heading": run.metrics["heading"],
                    "retrieval": run.metrics["retrieval"],
                    "nearest_line": run.metrics["nearestLine"],
                    "no_suggestion": run.metrics["noSuggestion"],
                    "errors": run.metrics["errors"],
                }
            ),
        )
    )
