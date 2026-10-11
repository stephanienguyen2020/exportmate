import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.database.models import PlaybookRevision, PlaybookRule


def list_live_rules(db: Session, company_id: uuid.UUID) -> list[PlaybookRule]:
    return list(
        db.scalars(
            select(PlaybookRule)
            .where(PlaybookRule.company_id == company_id, PlaybookRule.deleted_at.is_(None))
            .order_by(PlaybookRule.created_at, PlaybookRule.id)
        )
    )


def get_live_rule(db: Session, company_id: uuid.UUID, rule_id: uuid.UUID) -> PlaybookRule | None:
    return db.scalar(
        select(PlaybookRule).where(
            PlaybookRule.id == rule_id,
            PlaybookRule.company_id == company_id,
            PlaybookRule.deleted_at.is_(None),
        )
    )


def add_rule(db: Session, rule: PlaybookRule) -> PlaybookRule:
    db.add(rule)
    db.flush()
    return rule


def get_latest_revision_number(db: Session, company_id: uuid.UUID) -> int:
    return db.scalar(
        select(func.coalesce(func.max(PlaybookRevision.revision), 0)).where(
            PlaybookRevision.company_id == company_id
        )
    )


def add_playbook_revision(
    db: Session, *, company_id: uuid.UUID, revision: int, rules: list[dict], user_id: uuid.UUID
) -> PlaybookRevision:
    item = PlaybookRevision(
        company_id=company_id, revision=revision, rules=rules, created_by=user_id
    )
    db.add(item)
    db.flush()
    return item
