"""Supplier messages and report feedback."""

import uuid

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.database.models import ReportFeedback, SupplierMessage


def add_supplier_message(db: Session, message: SupplierMessage) -> SupplierMessage:
    db.add(message)
    db.flush()
    return message


def get_company_supplier_message(
    db: Session, company_id: uuid.UUID, message_id: uuid.UUID, *, for_update: bool = False
) -> SupplierMessage | None:
    stmt = select(SupplierMessage).where(
        SupplierMessage.id == message_id, SupplierMessage.company_id == company_id
    )
    if for_update:
        stmt = stmt.with_for_update()
    return db.scalar(stmt)


def list_order_supplier_messages(db: Session, order_id: uuid.UUID) -> list[SupplierMessage]:
    return list(
        db.scalars(
            select(SupplierMessage)
            .where(SupplierMessage.order_id == order_id)
            .order_by(SupplierMessage.created_at.desc(), SupplierMessage.id)
        )
    )


def upsert_report_feedback(db: Session, row: dict) -> None:
    """One verdict per person and report; a new one replaces theirs."""
    stmt = insert(ReportFeedback).values(row)
    db.execute(
        stmt.on_conflict_do_update(
            index_elements=["report_id", "user_id"],
            set_={"useful": stmt.excluded.useful, "note": stmt.excluded.note},
        )
    )


def count_report_feedback(db: Session, report_id: uuid.UUID) -> tuple[int, int]:
    """(useful, not useful)."""
    useful, not_useful = db.execute(
        select(
            func.count().filter(ReportFeedback.useful.is_(True)),
            func.count().filter(ReportFeedback.useful.is_(False)),
        ).where(ReportFeedback.report_id == report_id)
    ).one()
    return useful, not_useful


def get_user_report_feedback(
    db: Session, report_id: uuid.UUID, user_id: uuid.UUID
) -> ReportFeedback | None:
    return db.scalar(
        select(ReportFeedback).where(
            ReportFeedback.report_id == report_id, ReportFeedback.user_id == user_id
        )
    )
