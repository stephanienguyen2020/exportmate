import uuid
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import EditorContext, ViewerContext
from app.core.config import get_settings
from app.core.rate_limit import RateLimiter
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.solutions import (
    SolutionCaseOut,
    SolutionNoteIn,
    SolutionOut,
    SolutionProblemOut,
    SolutionReviewIn,
    SolutionSuggestIn,
    SolutionUseIn,
)
from app.services import solutions as solution_service

router = APIRouter(tags=["solutions"])
Db = Annotated[Session, Depends(get_db)]
suggest_limiter = RateLimiter("solution suggestions")


@router.get("/solutions", response_model=SuccessResponse[list[SolutionProblemOut]])
def list_company_solutions(ctx: ViewerContext, db: Db):
    """The knowledge base: every solution the company saved, grouped by problem (market,
    requirement, missing or wrong), with notes, uses and whether each is still valid."""
    return success_response(solution_service.list_company_solutions(db, ctx))


@router.get("/reports/{report_id}/solutions", response_model=SuccessResponse[list[SolutionCaseOut]])
def list_report_solutions(report_id: uuid.UUID, ctx: ViewerContext, db: Db):
    """Each missing or wrong document in the report, with the company's saved solutions to the
    same problem: the default (never expired or rejected), other valid ones, and expired ones
    for reference."""
    return success_response(solution_service.list_report_solutions(db, ctx, report_id))


@router.post(
    "/reports/{report_id}/solutions",
    response_model=SuccessResponse[SolutionCaseOut],
    status_code=201,
)
def suggest_solution(report_id: uuid.UUID, payload: SolutionSuggestIn, ctx: EditorContext, db: Db):
    """AI writes a new solution to one problem, from the report's facts, the cited text and
    the company's notes on earlier solutions. Use it to analyse an expired one again."""
    suggest_limiter.check(str(ctx.user.id), get_settings().solution_suggestions_per_hour)
    return success_response(
        solution_service.suggest_solution(db, ctx, report_id, payload.requirement_key)
    )


@router.post("/solutions/{solution_id}/use", response_model=SuccessResponse[SolutionCaseOut])
def use_solution(solution_id: uuid.UUID, payload: SolutionUseIn, ctx: EditorContext, db: Db):
    """Record that this solution is the one followed for the report's matching problem.
    Expired and rejected solutions can't be used (409)."""
    return success_response(solution_service.use_solution(db, ctx, solution_id, payload.report_id))


@router.post("/solutions/{solution_id}/notes", response_model=SuccessResponse[SolutionOut])
def add_solution_note(solution_id: uuid.UUID, payload: SolutionNoteIn, ctx: EditorContext, db: Db):
    """A note on how the company handles this problem. Kept for good and read by the AI the
    next time it writes a solution to the same problem."""
    return success_response(solution_service.add_solution_note(db, ctx, solution_id, payload.text))


@router.post("/solutions/{solution_id}/review", response_model=SuccessResponse[SolutionOut])
def review_solution(solution_id: uuid.UUID, payload: SolutionReviewIn, ctx: EditorContext, db: Db):
    """Adopt (offered first for this problem) or reject (never the default). Expired solutions
    can't be adopted."""
    return success_response(
        solution_service.review_solution(db, ctx, solution_id, payload.verdict, payload.note)
    )
