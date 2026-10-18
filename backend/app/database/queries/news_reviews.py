"""Verdicts on whether News watch alerts affect a company's orders."""

import uuid

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.database.models import NewsOrderReview, NewsVerdict, Order


def list_news_reviews(db: Session, company_id: uuid.UUID) -> list[NewsOrderReview]:
    return list(db.scalars(select(NewsOrderReview).where(NewsOrderReview.company_id == company_id)))


def list_reviews_with_path(
    db: Session, company_id: uuid.UUID | None = None
) -> list[NewsOrderReview]:
    """Verdicts on suggestions that kept a path, for link feedback: one company's, or every
    company's (the nightly link weights job)."""
    query = select(NewsOrderReview).where(NewsOrderReview.path.is_not(None))
    if company_id is not None:
        query = query.where(NewsOrderReview.company_id == company_id)
    return list(db.scalars(query))


def list_confirmed_news_by_impact(db: Session, company_id: uuid.UUID) -> dict[str, list[str]]:
    """Impact ID → external IDs of the orders a person confirmed it affects."""
    rows = db.execute(
        select(NewsOrderReview.impact_id, Order.external_id)
        .join(Order, Order.id == NewsOrderReview.order_id)
        .where(
            NewsOrderReview.company_id == company_id,
            NewsOrderReview.verdict == NewsVerdict.relevant,
        )
        .order_by(Order.external_id)
    ).all()
    confirmed: dict[str, list[str]] = {}
    for impact_id, external_id in rows:
        confirmed.setdefault(impact_id, []).append(external_id)
    return confirmed


def get_news_review(
    db: Session, company_id: uuid.UUID, impact_id: str, order_id: uuid.UUID
) -> NewsOrderReview | None:
    # populate_existing: an upsert just changed the row behind the session's copy.
    return db.scalar(
        select(NewsOrderReview)
        .where(
            NewsOrderReview.company_id == company_id,
            NewsOrderReview.impact_id == impact_id,
            NewsOrderReview.order_id == order_id,
        )
        .execution_options(populate_existing=True)
    )


def upsert_news_review(db: Session, row: dict) -> None:
    """One verdict per alert and order; a new one replaces it, whoever gave it."""
    stmt = insert(NewsOrderReview).values(row)
    db.execute(
        stmt.on_conflict_do_update(
            index_elements=["company_id", "impact_id", "order_id"],
            set_={
                key: stmt.excluded[key]
                for key in (
                    "verdict",
                    "note",
                    "suggested",
                    "reason",
                    "headline",
                    "url",
                    "reviewed_by",
                    "reviewed_at",
                )
            },
        )
    )


def delete_news_review(
    db: Session, company_id: uuid.UUID, impact_id: str, order_id: uuid.UUID
) -> bool:
    result = db.execute(
        delete(NewsOrderReview).where(
            NewsOrderReview.company_id == company_id,
            NewsOrderReview.impact_id == impact_id,
            NewsOrderReview.order_id == order_id,
        )
    )
    return result.rowcount > 0
