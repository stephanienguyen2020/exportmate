"""HS headings (searched by embedding or by words), similar past orders, and suggestions."""

import uuid
from datetime import datetime

from sqlalchemy import case, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.database.models import HsCodeSuggestion, HsHeading, HsSuggestionStatus, Order

# Product names this similar (pg_trgm, 0–1) count as the same kind of product.
SIMILAR_PRODUCT = 0.3


# --- Official headings


def upsert_hs_headings(db: Session, rows: list[dict]) -> None:
    """Insert or update; a changed description loses its embedding so it is embedded again."""
    if not rows:
        return
    stmt = insert(HsHeading).values(rows)
    db.execute(
        stmt.on_conflict_do_update(
            index_elements=["code"],
            set_={
                "digits": stmt.excluded.digits,
                "level": stmt.excluded.level,
                "description": stmt.excluded.description,
                "text_hash": stmt.excluded.text_hash,
                "embedding": case(
                    (HsHeading.text_hash == stmt.excluded.text_hash, HsHeading.embedding),
                    else_=None,
                ),
            },
        )
    )


def list_headings_without_embedding(db: Session) -> list[HsHeading]:
    return list(
        db.scalars(select(HsHeading).where(HsHeading.embedding.is_(None)).order_by(HsHeading.code))
    )


def set_heading_embeddings(db: Session, vectors: dict[str, list[float]]) -> None:
    """One bulk UPDATE by primary key."""
    if vectors:
        db.execute(
            update(HsHeading), [{"code": code, "embedding": v} for code, v in vectors.items()]
        )


def count_hs_headings(db: Session) -> tuple[int, int]:
    """(headings, embedded headings)."""
    total, embedded = db.execute(
        select(func.count(), func.count(HsHeading.embedding)).select_from(HsHeading)
    ).one()
    return total, embedded


def list_nearest_headings(db: Session, vector: list[float], limit: int) -> list[HsHeading]:
    """6-digit subheadings closest in meaning (cosine distance)."""
    return list(
        db.scalars(
            select(HsHeading)
            .where(HsHeading.level == 6, HsHeading.embedding.is_not(None))
            .order_by(HsHeading.embedding.cosine_distance(vector))
            .limit(limit)
        )
    )


def list_headings_by_words(db: Session, text: str, limit: int) -> list[HsHeading]:
    """6-digit subheadings sharing the most words with `text` (when nothing is embedded)."""
    score = func.word_similarity(text, HsHeading.description)
    return list(
        db.scalars(
            select(HsHeading)
            .where(HsHeading.level == 6, score > 0)
            .order_by(score.desc(), HsHeading.code)
            .limit(limit)
        )
    )


def get_hs_heading_by_digits(db: Session, digits: str) -> HsHeading | None:
    return db.scalar(select(HsHeading).where(HsHeading.digits == digits))


# --- The company's own past orders


def list_similar_coded_orders(
    db: Session, company_id: uuid.UUID, product: str, exclude_order_id: uuid.UUID, limit: int
) -> list[tuple[Order, float]]:
    """The company's orders with an HS code whose product name is like `product`."""
    score = func.similarity(Order.product, product)
    rows = db.execute(
        select(Order, score)
        .where(
            Order.company_id == company_id,
            Order.id != exclude_order_id,
            Order.hs_code != "",
            score >= SIMILAR_PRODUCT,
        )
        .order_by(score.desc(), Order.external_id)
        .limit(limit)
    ).all()
    return [(order, float(similarity)) for order, similarity in rows]


# --- Suggestions


def list_order_hs_suggestions(db: Session, order_id: uuid.UUID) -> list[HsCodeSuggestion]:
    return list(
        db.scalars(
            select(HsCodeSuggestion)
            .where(HsCodeSuggestion.order_id == order_id)
            .order_by(HsCodeSuggestion.created_at.desc(), HsCodeSuggestion.id)
        )
    )


def add_hs_suggestions(db: Session, suggestions: list[HsCodeSuggestion]) -> None:
    db.add_all(suggestions)
    db.flush()


def reject_pending_hs_suggestions(
    db: Session, order_id: uuid.UUID, user_id: uuid.UUID, decided_at: datetime
) -> None:
    db.execute(
        update(HsCodeSuggestion)
        .where(
            HsCodeSuggestion.order_id == order_id,
            HsCodeSuggestion.status == HsSuggestionStatus.pending,
        )
        .values(status=HsSuggestionStatus.rejected, decided_by=user_id, decided_at=decided_at)
    )


def get_company_hs_suggestion(
    db: Session, company_id: uuid.UUID, suggestion_id: uuid.UUID
) -> HsCodeSuggestion | None:
    return db.scalar(
        select(HsCodeSuggestion)
        .where(HsCodeSuggestion.id == suggestion_id, HsCodeSuggestion.company_id == company_id)
        .with_for_update()
    )
