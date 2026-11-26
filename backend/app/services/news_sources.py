"""News watch's sources and the age rule (moved from the AI service's /api/sources and
/api/scan-rules; the AI service's news scan reads the same Firestore records).

Built-in sources, and custom ones added before sources had owners, are shared by every
workspace: a company can switch one off for itself only. A custom source belongs to the
company that added it: only that company sees it, and its owners and editors switch it off or
remove it. Signed out is the browser demo: the demo company (DEMO_COMPANY_ID), which has no
account, so nothing it sees can be changed.

The age rule: a scan skips articles published more than SCAN_MAX_AGE_DAYS before it; a
company can switch that off for itself (Firestore `companySources/{id}.skipOld` false)."""

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.context import CompanyContext
from app.core.errors import AppError, not_found_error
from app.core.feeds import FeedError, fetch_feed
from app.database.news_store import get_news_store
from app.database.queries import audit as audit_queries
from app.schemas.news_sources import (
    FeedArticleOut,
    NewsSettingsOut,
    NewsSourceAddedOut,
    NewsSourceIn,
    NewsSourceOut,
)

# Custom feeds each company may add, and in all (each scan reads every enabled feed).
MAX_COMPANY_SOURCES = 10
MAX_SOURCES = 100
SAMPLE_ARTICLES = 3

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class NewsAccess:
    """Whose view of News watch: the company (the demo company signed out), the shared sources
    it switched off, and whether it switched the age rule off."""

    company_id: str
    disabled: list[str] = field(default_factory=list)
    skip_old_off: bool = False


def news_access(ctx: CompanyContext | None) -> NewsAccess:
    company_id = str(ctx.company_id) if ctx else get_settings().demo_company_id
    stored = get_news_store().get_company_settings(company_id)
    disabled = stored.get("disabled")
    return NewsAccess(
        company_id=company_id,
        disabled=list(disabled) if isinstance(disabled, list) else [],
        skip_old_off=stored.get("skipOld") is False,
    )


def is_shared(source: dict) -> bool:
    return bool(source.get("builtIn")) or not source.get("companyId")


def source_visible(source: dict, access: NewsAccess) -> bool:
    return is_shared(source) or source.get("companyId") == access.company_id


def source_enabled(source: dict, access: NewsAccess) -> bool:
    return bool(source.get("enabled")) and not (
        is_shared(source) and source["id"] in access.disabled
    )


def present_source(source: dict, access: NewsAccess) -> NewsSourceOut:
    """A source as the caller sees it, without its owner's id."""
    return NewsSourceOut(
        id=source["id"],
        name=source.get("name", ""),
        url=source.get("url", ""),
        kind=source.get("kind", ""),
        built_in=bool(source.get("builtIn")),
        shared=is_shared(source),
        enabled=source_enabled(source, access),
        added_at=source.get("addedAt"),
        last_fetched_at=source.get("lastFetchedAt"),
        last_ok=source.get("lastOk"),
        last_count=source.get("lastCount"),
        last_error=source.get("lastError"),
    )


def list_news_sources(ctx: CompanyContext | None) -> list[NewsSourceOut]:
    access = news_access(ctx)
    return [
        present_source(s, access)
        for s in get_news_store().list_sources()
        if source_visible(s, access)
    ]


def add_news_source(db: Session, ctx: CompanyContext, payload: NewsSourceIn) -> NewsSourceAddedOut:
    """Adds a feed the company owns, after reading it once (only public HTTPS feeds)."""
    store = get_news_store()
    access = news_access(ctx)
    existing = store.list_sources()
    if sum(1 for s in existing if s.get("companyId") == access.company_id) >= MAX_COMPANY_SOURCES:
        raise AppError(
            400, "too_many_sources", f"Up to {MAX_COMPANY_SOURCES} custom sources per company."
        )
    if len(existing) >= MAX_SOURCES:
        raise AppError(400, "too_many_sources", "No more sources can be added right now.")
    if any(s.get("url") == payload.url and source_visible(s, access) for s in existing):
        raise AppError(409, "source_exists", "That feed is already a source.")
    try:
        sample = fetch_feed(payload.url, limit=SAMPLE_ARTICLES)
    except FeedError as error:
        raise AppError(
            400, "feed_unreadable", f"Couldn't read that feed: {error}", {"url": str(error)}
        ) from error
    source = {
        "name": payload.name,
        "url": payload.url,
        "kind": "Custom",
        "builtIn": False,
        "enabled": True,
        "companyId": access.company_id,
        "addedBy": str(ctx.user.id),
        "addedAt": _now(),
    }
    source_id = store.add_source(source)
    _record(db, ctx, "news_source.added", source_id, {"name": payload.name, "url": payload.url})
    return NewsSourceAddedOut(
        source=present_source({"id": source_id, **source}, access),
        sample=[FeedArticleOut.model_validate(a) for a in sample],
    )


def set_news_source_enabled(
    db: Session, ctx: CompanyContext, source_id: str, enabled: bool
) -> NewsSourceOut:
    """Switching a shared source off only affects the caller's company; the company's own
    source is switched off for real (it is the only one reading it)."""
    store = get_news_store()
    access = news_access(ctx)
    source = _visible_source(source_id, access)
    if is_shared(source):
        store.set_source_disabled(
            access.company_id,
            source_id,
            not enabled,
            {"updatedAt": _now(), "updatedBy": str(ctx.user.id)},
        )
        disabled = [i for i in access.disabled if i != source_id] + ([] if enabled else [source_id])
        access = NewsAccess(access.company_id, disabled, access.skip_old_off)
    else:
        store.update_source(source_id, {"enabled": enabled})
        source = {**source, "enabled": enabled}
    action = "news_source.enabled" if enabled else "news_source.disabled"
    _record(db, ctx, action, source_id, {"name": source.get("name"), "shared": is_shared(source)})
    return present_source(source, access)


def delete_news_source(db: Session, ctx: CompanyContext, source_id: str) -> None:
    access = news_access(ctx)
    source = _visible_source(source_id, access)
    if source.get("builtIn"):
        raise AppError(400, "built_in_source", "Built-in sources can be turned off, not deleted.")
    if is_shared(source):
        raise AppError(
            400,
            "shared_source",
            "This source is shared by every workspace. Switch it off instead.",
        )
    get_news_store().delete_source(source_id)
    _record(
        db,
        ctx,
        "news_source.deleted",
        source_id,
        {"name": source.get("name"), "url": source["url"]},
    )


def get_news_settings(ctx: CompanyContext | None) -> NewsSettingsOut | None:
    """None when no age rule is set on this service."""
    max_age_days = get_settings().scan_max_age_days
    if max_age_days <= 0:
        return None
    return NewsSettingsOut(max_age_days=max_age_days, skip_old=not news_access(ctx).skip_old_off)


def update_news_settings(db: Session, ctx: CompanyContext, skip_old: bool) -> NewsSettingsOut:
    if get_settings().scan_max_age_days <= 0:
        raise AppError(400, "no_age_rule", "No age rule is set on this service.")
    get_news_store().update_company_settings(
        str(ctx.company_id),
        {"skipOld": skip_old, "updatedAt": _now(), "updatedBy": str(ctx.user.id)},
    )
    _record(db, ctx, "news_settings.updated", str(ctx.company_id), {"skipOld": skip_old})
    return NewsSettingsOut(max_age_days=get_settings().scan_max_age_days, skip_old=skip_old)


def _visible_source(source_id: str, access: NewsAccess) -> dict:
    """The source, or 404 (also for another company's own source)."""
    source = get_news_store().get_source(source_id)
    if source is None or not source_visible(source, access):
        raise not_found_error("Source")
    return source


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _record(db: Session, ctx: CompanyContext, action: str, object_id: str, data: dict) -> None:
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action=action,
        object_type="news_source" if action.startswith("news_source") else "news_settings",
        object_id=object_id,
        data=data,
    )
    db.commit()
    log.info(action, extra={"object_id": object_id})
