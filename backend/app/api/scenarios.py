import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.auth import EditorContext, ViewerContext
from app.core.config import get_settings
from app.core.rate_limit import RateLimiter
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.scenarios import (
    ScenarioIn,
    ScenarioNoteIn,
    ScenarioOut,
    ScenarioSuggestionOut,
    ScenarioTargetIn,
)
from app.services import scenarios as scenario_service

router = APIRouter(prefix="/trade-map/scenarios", tags=["trade map"])
Db = Annotated[Session, Depends(get_db)]
suggestion_limiter = RateLimiter("what-if suggestions")


@router.get("", response_model=SuccessResponse[list[ScenarioOut]])
def list_scenarios(
    ctx: ViewerContext,
    db: Db,
    order_id: Annotated[str | None, Query(alias="orderId", min_length=1, max_length=100)] = None,
):
    """Saved what-ifs, newest change first; one order's with `orderId`."""
    return success_response(scenario_service.list_scenarios(db, ctx, order_id))


@router.post("", response_model=SuccessResponse[ScenarioOut])
def save_scenario(payload: ScenarioIn, ctx: EditorContext, db: Db):
    """Save a what-if (another market, ship date or route for one order) with a note. Saving
    the same what-if again replaces its note and comparison. The order itself is unchanged."""
    return success_response(scenario_service.save_scenario(db, ctx, payload))


@router.post("/suggest", response_model=SuccessResponse[ScenarioSuggestionOut])
def suggest_scenario_note(payload: ScenarioTargetIn, ctx: EditorContext, db: Db):
    """An AI reading of one comparison: a summary, next steps and questions, each naming the
    comparison lines it rests on. Not saved; the editor uses it to write their note."""
    suggestion_limiter.check(str(ctx.user.id), get_settings().scenario_suggestions_per_hour)
    return success_response(scenario_service.suggest_scenario_note(db, ctx, payload))


@router.patch("/{scenario_id}", response_model=SuccessResponse[ScenarioOut])
def update_scenario_note(
    scenario_id: uuid.UUID, payload: ScenarioNoteIn, ctx: EditorContext, db: Db
):
    """Edit the note. The saved comparison stays as it was."""
    return success_response(scenario_service.update_scenario_note(db, ctx, scenario_id, payload))


@router.delete("/{scenario_id}", response_model=SuccessResponse[dict])
def delete_scenario(scenario_id: uuid.UUID, ctx: EditorContext, db: Db):
    scenario_service.delete_scenario(db, ctx, scenario_id)
    return success_response({"deleted": True})
