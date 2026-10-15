"""Which orders a News watch alert may affect, and people's verdicts on it.

The AI service matches each article to items in its sample stock (SKU, HS code, markets). Here
an open order is suggested for an alert when it shares an HS heading (first four digits) with
an item the alert names and ships to one of that item's markets. A suggestion is only a guess:
an editor confirms or rejects it, or links an order that wasn't suggested, and reports and the
order list only treat confirmed links as fact.
"""

import logging
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime

from sqlalchemy.orm import Session

from app.core.context import CompanyContext
from app.core.errors import AppError, not_found_error
from app.core.news_alerts import fetch_news_alerts, fetch_news_stock
from app.database.models import NewsOrderReview, NewsVerdict, Order, User
from app.database.queries import audit as audit_queries
from app.database.queries import news_reviews as news_queries
from app.database.queries import orders as order_queries
from app.schemas.news import (
    NewsMatchesOut,
    NewsOrderMatchOut,
    NewsReviewerOut,
    NewsReviewIn,
    NewsReviewOut,
)
from app.services.trade_map import load_gazetteer, locate_destination

log = logging.getLogger(__name__)
MARKET_CODE = re.compile(r"^[A-Z]{2}$")
LINKED_REASON = "Linked by a reviewer; ExportMate did not suggest this order."


@dataclass(frozen=True)
class SuggestedOrder:
    order: Order
    market: str | None
    reason: str


def hs_heading(hs_code: object) -> str:
    """The first four digits of an HS code ("4412.33" → "4412"); "" when there are fewer."""
    digits = re.sub(r"\D", "", str(hs_code or ""))
    return digits[:4] if len(digits) >= 4 else ""


def suggest_orders(
    alert: dict, stock_by_sku: dict[str, dict], open_orders: list[tuple[Order, str | None]]
) -> list[SuggestedOrder]:
    """Open orders sharing an HS heading and a market with an item the alert names."""
    suggested: dict[uuid.UUID, SuggestedOrder] = {}
    affected = alert.get("affected") if isinstance(alert.get("affected"), list) else []
    for entry in affected:
        if not isinstance(entry, dict):
            continue
        item = stock_by_sku.get(str(entry.get("sku")))
        heading = hs_heading(item.get("hsCode")) if item else ""
        if not heading:
            continue
        # "Raw material" and the like aren't export markets: match on the heading alone.
        markets = {
            m for m in item.get("markets") or [] if isinstance(m, str) and MARKET_CODE.match(m)
        }
        for order, market in open_orders:
            if order.id in suggested or hs_heading(order.hs_code) != heading:
                continue
            if markets and market not in markets:
                continue
            where = f" and ships to {market}" if markets else ""
            name = item.get("name") or entry.get("name") or ""
            suggested[order.id] = SuggestedOrder(
                order=order,
                market=market,
                reason=f"HS {heading}{where}, like {entry.get('sku')} {name} named in this alert."[
                    :500
                ],
            )
    return list(suggested.values())


def _reviewer(db: Session, user_id: uuid.UUID) -> NewsReviewerOut:
    user = db.get(User, user_id)
    return NewsReviewerOut(id=user.id, name=user.name or user.email)


def _review_out(db: Session, review: NewsOrderReview | None) -> NewsReviewOut | None:
    if review is None:
        return None
    return NewsReviewOut(
        verdict=review.verdict.value,
        note=review.note,
        reviewed_by=_reviewer(db, review.reviewed_by),
        reviewed_at=review.reviewed_at,
    )


def _alert_id(alert: dict) -> str:
    """News watch keys an alert by its article's ID (`id`, also stored as `articleId`)."""
    return str(alert.get("id") or alert.get("articleId") or "")


def build_news_matches(
    db: Session, ctx: CompanyContext, authorization: str | None
) -> NewsMatchesOut:
    alerts = fetch_news_alerts(authorization)
    if alerts is None:
        return NewsMatchesOut(news_available=False, matches=[])
    stock = {str(i.get("sku")): i for i in fetch_news_stock(authorization) or []}
    gazetteer = load_gazetteer(db)
    orders = order_queries.list_company_orders(db, ctx.company_id)
    markets = {o.id: locate_destination(o.destination, gazetteer).market for o in orders}
    # Only orders that haven't shipped are suggested.
    today = date.today()
    open_orders = [(o, markets[o.id]) for o in orders if o.ship_date >= today]
    orders_by_id = {o.id: o for o in orders}
    reviews = {
        (r.impact_id, r.order_id): r for r in news_queries.list_news_reviews(db, ctx.company_id)
    }
    matches: list[NewsOrderMatchOut] = []
    for alert in alerts:
        impact_id = _alert_id(alert)
        if not impact_id:
            continue
        shown: set[uuid.UUID] = set()
        for suggestion in suggest_orders(alert, stock, open_orders):
            shown.add(suggestion.order.id)
            matches.append(
                _match_out(
                    db,
                    impact_id,
                    suggestion.order,
                    suggestion.market,
                    True,
                    suggestion.reason,
                    reviews.get((impact_id, suggestion.order.id)),
                )
            )
        # Orders a person linked, or that are no longer suggested (shipped, HS code changed),
        # keep their verdict on show.
        for (review_impact, order_id), review in reviews.items():
            order = orders_by_id.get(order_id)
            if review_impact != impact_id or order_id in shown or order is None:
                continue
            matches.append(
                _match_out(
                    db, impact_id, order, markets[order.id], review.suggested, review.reason, review
                )
            )
    return NewsMatchesOut(news_available=True, matches=matches)


def _match_out(
    db: Session,
    impact_id: str,
    order: Order,
    market: str | None,
    suggested: bool,
    reason: str,
    review: NewsOrderReview | None,
) -> NewsOrderMatchOut:
    return NewsOrderMatchOut(
        impact_id=impact_id,
        order_id=order.external_id,
        product=order.product,
        destination=order.destination,
        market=market,
        ship_date=order.ship_date,
        suggested=suggested,
        reason=reason,
        review=_review_out(db, review),
    )


def _find_alert(impact_id: str, authorization: str | None) -> dict:
    alerts = fetch_news_alerts(authorization)
    if alerts is None:
        raise AppError(503, "news_unavailable", "News watch can't be reached. Try again shortly.")
    alert = next((a for a in alerts if _alert_id(a) == impact_id), None)
    if alert is None:
        raise not_found_error("News alert")
    return alert


def review_news_match(
    db: Session,
    ctx: CompanyContext,
    impact_id: str,
    external_id: str,
    payload: NewsReviewIn,
    authorization: str | None,
) -> NewsOrderMatchOut:
    """Confirm or reject that an alert affects an order. Any order of the company may be
    linked, so a person can add one ExportMate missed."""
    order = order_queries.get_order_by_external_id(db, ctx.company_id, external_id)
    if not order:
        raise not_found_error("Order")
    alert = _find_alert(impact_id, authorization)
    stock = {str(i.get("sku")): i for i in fetch_news_stock(authorization) or []}
    market = locate_destination(order.destination, load_gazetteer(db)).market
    suggestion = next(
        (s for s in suggest_orders(alert, stock, [(order, market)]) if s.order.id == order.id),
        None,
    )
    existing = news_queries.get_news_review(db, ctx.company_id, impact_id, order.id)
    # A link a person made stays theirs; a suggestion keeps the reason it was suggested for.
    suggested = existing.suggested if existing else suggestion is not None
    reason = existing.reason if existing else suggestion.reason if suggestion else LINKED_REASON
    note = (payload.note or "").strip() or None
    news_queries.upsert_news_review(
        db,
        {
            "company_id": ctx.company_id,
            "impact_id": impact_id,
            "order_id": order.id,
            "verdict": NewsVerdict(payload.verdict),
            "note": note,
            "suggested": suggested,
            "reason": reason,
            "headline": str(alert.get("headline") or alert.get("title") or "")[:500],
            "url": str(alert.get("url") or "")[:2000] or None,
            "reviewed_by": ctx.user.id,
            "reviewed_at": datetime.now(UTC),
        },
    )
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action="news.reviewed",
        object_type="order",
        object_id=order.external_id,
        data={
            "impactId": impact_id,
            "verdict": payload.verdict,
            "suggested": suggested,
            "note": note,
        },
    )
    db.commit()
    log.info(
        "news.reviewed",
        extra={
            "company_id": str(ctx.company_id),
            "impact_id": impact_id,
            "order_id": str(order.id),
            "verdict": payload.verdict,
            "suggested": suggested,
        },
    )
    review = news_queries.get_news_review(db, ctx.company_id, impact_id, order.id)
    return _match_out(db, impact_id, order, market, suggested, reason, review)


def clear_news_review(db: Session, ctx: CompanyContext, impact_id: str, external_id: str) -> None:
    """Undo a verdict: a suggested order goes back to awaiting review, a linked one is unlinked."""
    order = order_queries.get_order_by_external_id(db, ctx.company_id, external_id)
    if not order or not news_queries.delete_news_review(db, ctx.company_id, impact_id, order.id):
        raise not_found_error("News review")
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action="news.review_cleared",
        object_type="order",
        object_id=order.external_id,
        data={"impactId": impact_id},
    )
    db.commit()
    log.info(
        "news.review_cleared",
        extra={
            "company_id": str(ctx.company_id),
            "impact_id": impact_id,
            "order_id": str(order.id),
        },
    )
