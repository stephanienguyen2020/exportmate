import uuid
from typing import Annotated

from fastapi import APIRouter, Body, Depends
from sqlalchemy.orm import Session

from app.core.auth import EditorContext, ViewerContext
from app.core.config import get_settings
from app.core.rate_limit import RateLimiter
from app.database.session import get_db
from app.schemas.analysis import ReportOut, RunIn, RunOut
from app.schemas.common import SuccessResponse, success_response
from app.services import analysis as analysis_service

router = APIRouter(tags=["analysis"])
Db = Annotated[Session, Depends(get_db)]
run_limiter = RateLimiter("analysis runs")


@router.post("/runs", response_model=SuccessResponse[RunOut], status_code=201)
def start_run(ctx: EditorContext, db: Db, payload: Annotated[RunIn | None, Body()] = None):
    """Analyse every order (or `orderIds`): match → cost → playbook → plan → auditor.
    Returns the finished run with a report per order."""
    run_limiter.check(str(ctx.user.id), get_settings().analysis_runs_per_hour)
    order_ids = payload.order_ids if payload else None
    return success_response(analysis_service.start_run(db, ctx, order_ids))


@router.get("/runs/{run_id}", response_model=SuccessResponse[RunOut])
def get_run(run_id: uuid.UUID, ctx: ViewerContext, db: Db):
    """Run status, a short summary per step (no AI reasoning) and each order's report."""
    return success_response(analysis_service.get_run(db, ctx, run_id))


@router.get("/reports/{report_id}", response_model=SuccessResponse[ReportOut])
def get_report(report_id: uuid.UUID, ctx: ViewerContext, db: Db):
    """One order's report: findings with their quotes, cost lines with where each number came
    from, the playbook rules that fired, the suggested action and the audit."""
    return success_response(analysis_service.get_report(db, ctx, report_id))
