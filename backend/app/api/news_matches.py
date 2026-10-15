from typing import Annotated

from fastapi import APIRouter, Depends, Header, Path
from sqlalchemy.orm import Session

from app.core.auth import EditorContext, ViewerContext
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.news import NewsMatchesOut, NewsOrderMatchOut, NewsReviewIn
from app.services import news_matches as news_service

router = APIRouter(prefix="/news-matches", tags=["news"])
Db = Annotated[Session, Depends(get_db)]
ImpactId = Annotated[str, Path(pattern=r"^[\w-]{1,128}$")]


@router.get("", response_model=SuccessResponse[NewsMatchesOut])
def list_news_matches(
    ctx: ViewerContext, db: Db, authorization: Annotated[str | None, Header()] = None
):
    """For each News watch alert, the open orders it may affect (same HS heading and market as
    a stock item it names) and the orders people linked, with each verdict. Reads News watch
    with the caller's token."""
    return success_response(news_service.build_news_matches(db, ctx, authorization))


@router.put("/{impact_id}/orders/{order_id}", response_model=SuccessResponse[NewsOrderMatchOut])
def review_news_match(
    impact_id: ImpactId,
    order_id: str,
    payload: NewsReviewIn,
    ctx: EditorContext,
    db: Db,
    authorization: Annotated[str | None, Header()] = None,
):
    """Confirm (`relevant`) or reject (`not_relevant`) that an alert affects an order, with an
    optional note. Works for any of the company's orders, suggested or not."""
    return success_response(
        news_service.review_news_match(db, ctx, impact_id, order_id, payload, authorization)
    )


@router.delete("/{impact_id}/orders/{order_id}", response_model=SuccessResponse[dict])
def clear_news_review(impact_id: ImpactId, order_id: str, ctx: EditorContext, db: Db):
    """Undo a verdict."""
    news_service.clear_news_review(db, ctx, impact_id, order_id)
    return success_response({"deleted": True})
