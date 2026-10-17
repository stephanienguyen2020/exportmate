"""Which orders a News watch alert may affect, and people's verdicts on it.

The AI service matches each article to the company's goods (what its profile names and its
orders ship, each with an HS code and markets; ai/server/goods.js), and records what the
article names (`mentions`: materials, HS codes, origin countries, markets). Orders are
suggested by walking the knowledge graph (services/knowledge_graph.py) from those mentions,
through suppliers' sourcing and the material chain, and from each item the alert names (same
HS heading, shipping to one of the item's markets). A suggestion is only a guess:
an editor confirms or rejects it, or links an order that wasn't suggested, and reports and the
order list only treat confirmed links as fact.
"""

import logging
import re
import uuid
from collections import Counter
from dataclasses import asdict
from datetime import UTC, date, datetime
from itertools import pairwise

from sqlalchemy.orm import Session

from app.core.context import CompanyContext
from app.core.errors import AppError, not_found_error
from app.core.news_alerts import fetch_news_alerts, fetch_news_stock
from app.database.models import NewsOrderReview, NewsVerdict, Order, User
from app.database.queries import audit as audit_queries
from app.database.queries import news_reviews as news_queries
from app.database.queries import orders as order_queries
from app.schemas.news import (
    AccuracyByLinkOut,
    AccuracyByWayOut,
    NewsMatchAccuracyOut,
    NewsMatchesOut,
    NewsOrderMatchOut,
    NewsPathStepOut,
    NewsReviewerOut,
    NewsReviewIn,
    NewsReviewOut,
)
from app.services.knowledge_graph import GraphMatch, GraphMentions, GraphPathStep, GraphWalker
from app.services.trade_map import load_gazetteer, locate_destination

log = logging.getLogger(__name__)
MARKET_CODE = re.compile(r"^[A-Z]{2}$")
LINKED_REASON = "Linked by a reviewer; ExportMate did not suggest this order."


def _strings(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(str(v).strip()[:100] for v in value if isinstance(v, str | int) and str(v).strip())


def alert_mentions(alert: dict, stock_by_sku: dict[str, dict]) -> list[GraphMentions]:
    """What to walk the graph from: what the article names, then each stock item it affects."""
    found: list[GraphMentions] = []
    mentions = alert.get("mentions")
    if isinstance(mentions, dict):
        found.append(
            GraphMentions(
                materials=_strings(mentions.get("materials")),
                hs_codes=_strings(mentions.get("hsCodes")),
                origin_countries=tuple(
                    c.upper() for c in _strings(mentions.get("originCountries")) if len(c) == 2
                ),
                markets=tuple(m for m in _strings(mentions.get("markets")) if MARKET_CODE.match(m)),
            )
        )
    affected = alert.get("affected") if isinstance(alert.get("affected"), list) else []
    for entry in affected:
        if not isinstance(entry, dict):
            continue
        item = stock_by_sku.get(str(entry.get("sku")))
        if not item or not item.get("hsCode"):
            continue
        # "Raw material" and the like aren't export markets: match on the heading alone.
        markets = tuple(
            m for m in item.get("markets") or [] if isinstance(m, str) and MARKET_CODE.match(m)
        )
        name = item.get("name") or entry.get("name") or entry.get("sku")
        found.append(
            GraphMentions(
                hs_codes=(str(item["hsCode"]),),
                markets=markets,
                named_as=f"like {name} named in this alert",
            )
        )
    return found


def suggest_orders(
    walker: GraphWalker,
    alert: dict,
    stock_by_sku: dict[str, dict],
    open_orders: list[tuple[Order, str | None]],
) -> list[GraphMatch]:
    """Open orders the graph reaches from the alert; the first path found for an order wins."""
    suggested: dict[uuid.UUID, GraphMatch] = {}
    for mentions in alert_mentions(alert, stock_by_sku):
        for match in walker.find_matches(mentions, open_orders):
            suggested.setdefault(match.order.id, match)
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
    walker = GraphWalker(db, ctx.company_id)
    reviews = {
        (r.impact_id, r.order_id): r for r in news_queries.list_news_reviews(db, ctx.company_id)
    }
    matches: list[NewsOrderMatchOut] = []
    for alert in alerts:
        impact_id = _alert_id(alert)
        if not impact_id:
            continue
        shown: set[uuid.UUID] = set()
        for suggestion in suggest_orders(walker, alert, stock, open_orders):
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
                    suggestion.path,
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
    path: list[GraphPathStep] | None = None,
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
        path=[NewsPathStepOut.model_validate(step, from_attributes=True) for step in path or []],
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
        (
            s
            for s in suggest_orders(
                GraphWalker(db, ctx.company_id), alert, stock, [(order, market)]
            )
            if s.order.id == order.id
        ),
        None,
    )
    existing = news_queries.get_news_review(db, ctx.company_id, impact_id, order.id)
    # A link a person made stays theirs; a suggestion keeps the reason it was suggested for.
    suggested = existing.suggested if existing else suggestion is not None
    # How it was found, kept from the first verdict like the reason.
    via = existing.via if existing else suggestion.via if suggestion else None
    path = (
        existing.path
        if existing
        else [asdict(step) for step in suggestion.path]
        if suggestion
        else None
    )
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
            "via": via,
            "path": path,
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
            "via": via,
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


def news_match_accuracy(db: Session, ctx: CompanyContext) -> NewsMatchAccuracyOut:
    """Confirmed and rejected verdicts by the way each suggestion was found, and by each chain
    link in the supplier paths people judged: a link that keeps showing up in rejected paths
    is a candidate to fix or mark secondary."""
    ways: Counter = Counter()
    links: Counter = Counter()
    for review in news_queries.list_news_reviews(db, ctx.company_id):
        verdict = "confirmed" if review.verdict == NewsVerdict.relevant else "rejected"
        ways[(review.via or "linked", verdict)] += 1
        steps = review.path or []
        for before, step in pairwise(steps):
            if before.get("kind") == "product" and step.get("kind") == "product":
                links[(before["label"], step["label"], step.get("link") or "", verdict)] += 1
    by_link = {}
    for (from_label, to_label, link, verdict), count in links.items():
        row = by_link.setdefault(
            (from_label, to_label, link),
            {
                "from_label": from_label,
                "to_label": to_label,
                "link": link,
                "confirmed": 0,
                "rejected": 0,
            },
        )
        row[verdict] += count
    return NewsMatchAccuracyOut(
        by_way=[
            AccuracyByWayOut(
                via=via, confirmed=ways[(via, "confirmed")], rejected=ways[(via, "rejected")]
            )
            for via in ("supplier", "hs", "linked")
            if ways[(via, "confirmed")] or ways[(via, "rejected")]
        ],
        by_link=sorted(
            (AccuracyByLinkOut(**row) for row in by_link.values()),
            key=lambda row: (-row.rejected, -row.confirmed, row.from_label),
        ),
    )
