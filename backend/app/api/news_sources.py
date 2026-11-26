from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import EditorContext, OptionalContext
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.news_alerts import NewsAlertsOut, NewsGoodsOut
from app.schemas.news_sources import (
    NewsSettingsOut,
    NewsSettingsUpdate,
    NewsSourceAddedOut,
    NewsSourceIn,
    NewsSourceOut,
    NewsSourceUpdate,
)
from app.services import news_alerts as news_alert_service
from app.services import news_goods as news_goods_service
from app.services import news_scan_runs
from app.services import news_sources as news_service

router = APIRouter(tags=["news watch"])
Db = Annotated[Session, Depends(get_db)]


@router.get("/news-sources", response_model=SuccessResponse[list[NewsSourceOut]])
def list_news_sources(ctx: OptionalContext):
    """The feeds News watch reads for the caller (signed out: the shared ones)."""
    return success_response(news_service.list_news_sources(ctx))


@router.post("/news-sources", response_model=SuccessResponse[NewsSourceAddedOut], status_code=201)
def add_news_source(payload: NewsSourceIn, ctx: EditorContext, db: Db):
    """Add a public HTTPS RSS or Atom feed for the company; it is read once to check it."""
    return success_response(news_service.add_news_source(db, ctx, payload))


@router.patch("/news-sources/{source_id}", response_model=SuccessResponse[NewsSourceOut])
def update_news_source(source_id: str, payload: NewsSourceUpdate, ctx: EditorContext, db: Db):
    """Switch a source on or off for the company."""
    return success_response(
        news_service.set_news_source_enabled(db, ctx, source_id, payload.enabled)
    )


@router.delete("/news-sources/{source_id}", response_model=SuccessResponse[dict])
def delete_news_source(source_id: str, ctx: EditorContext, db: Db):
    """Remove one of the company's own sources (shared ones can only be switched off)."""
    news_service.delete_news_source(db, ctx, source_id)
    return success_response({"deleted": True})


@router.get("/news-settings", response_model=SuccessResponse[NewsSettingsOut | None])
def get_news_settings(ctx: OptionalContext):
    """The age rule for the caller's company; null when none is set on this service."""
    return success_response(news_service.get_news_settings(ctx))


@router.patch("/news-settings", response_model=SuccessResponse[NewsSettingsOut])
def update_news_settings(payload: NewsSettingsUpdate, ctx: EditorContext, db: Db):
    """Switch the age rule off (or back on) for the company only."""
    return success_response(news_service.update_news_settings(db, ctx, payload.skip_old))


@router.get("/news-alerts", response_model=SuccessResponse[NewsAlertsOut])
def list_news_alerts(ctx: OptionalContext):
    """The newest alerts about the caller's goods (signed out: the sample stock's) and the
    latest scan, as the caller sees them."""
    return success_response(news_alert_service.list_news_alerts(ctx))


@router.get("/news-goods", response_model=SuccessResponse[NewsGoodsOut])
def list_news_goods(ctx: OptionalContext, db: Db):
    """What News watch reads the news against: the company's goods, or the sample stock."""
    return success_response(news_goods_service.list_news_goods(db, ctx))


@router.post("/news-scans", response_model=SuccessResponse[dict], status_code=202)
def start_news_scan(ctx: EditorContext, db: Db):
    """ "Scan now": starts a scan (one at a time; at most once per 10 minutes) and returns its
    record, which GET /news-alerts follows until it ends."""
    return success_response({"scan": news_scan_runs.request_scan(db, ctx)})
