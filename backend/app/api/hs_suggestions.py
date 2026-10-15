import uuid
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import EditorContext, ViewerContext
from app.core.config import get_settings
from app.core.rate_limit import RateLimiter
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.hs_suggestions import HsSuggestionAcceptedOut, HsSuggestionOut
from app.services import hs_suggestions as hs_service

router = APIRouter(tags=["hs code suggestions"])
Db = Annotated[Session, Depends(get_db)]
suggestion_limiter = RateLimiter("HS code suggestions")


@router.get(
    "/orders/{order_id}/hs-suggestions", response_model=SuccessResponse[list[HsSuggestionOut]]
)
def list_hs_suggestions(order_id: str, ctx: ViewerContext, db: Db):
    """Suggestions for this order, newest first, with what was decided."""
    return success_response(hs_service.list_hs_suggestions(db, ctx, order_id))


@router.post(
    "/orders/{order_id}/hs-suggestions",
    response_model=SuccessResponse[list[HsSuggestionOut]],
    status_code=201,
)
def suggest_hs_codes(order_id: str, ctx: EditorContext, db: Db):
    """AI suggests up to 3 HS codes for an order imported without one, from the company's past
    orders and the official tariff lines closest to the product."""
    suggestion_limiter.check(str(ctx.user.id), get_settings().hs_suggestions_per_hour)
    return success_response(hs_service.suggest_hs_codes(db, ctx, order_id))


@router.post(
    "/hs-suggestions/{suggestion_id}/accept",
    response_model=SuccessResponse[HsSuggestionAcceptedOut],
)
def accept_hs_suggestion(suggestion_id: uuid.UUID, ctx: EditorContext, db: Db):
    """Give the order this code (the other suggestions are rejected) and analyse it again."""
    return success_response(hs_service.accept_hs_suggestion(db, ctx, suggestion_id))


@router.post(
    "/hs-suggestions/{suggestion_id}/reject", response_model=SuccessResponse[HsSuggestionOut]
)
def reject_hs_suggestion(suggestion_id: uuid.UUID, ctx: EditorContext, db: Db):
    return success_response(hs_service.reject_hs_suggestion(db, ctx, suggestion_id))
