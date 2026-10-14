import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database.models import ReportDraft


def add_report_draft(db: Session, draft: ReportDraft) -> ReportDraft:
    db.add(draft)
    db.flush()
    return draft


def get_user_report_draft(
    db: Session,
    company_id: uuid.UUID,
    user_id: uuid.UUID,
    draft_id: uuid.UUID,
    for_update: bool = False,
) -> ReportDraft | None:
    """A draft is its author's: other members of the company don't see it."""
    query = select(ReportDraft).where(
        ReportDraft.id == draft_id,
        ReportDraft.company_id == company_id,
        ReportDraft.created_by == user_id,
    )
    return db.scalar(query.with_for_update() if for_update else query)


def list_user_report_drafts(
    db: Session, company_id: uuid.UUID, user_id: uuid.UUID, limit: int
) -> list[ReportDraft]:
    return list(
        db.scalars(
            select(ReportDraft)
            .where(ReportDraft.company_id == company_id, ReportDraft.created_by == user_id)
            .order_by(ReportDraft.updated_at.desc())
            .limit(limit)
        )
    )
