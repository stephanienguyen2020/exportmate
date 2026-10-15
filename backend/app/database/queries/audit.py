import uuid
from datetime import datetime

from sqlalchemy import select, tuple_
from sqlalchemy.orm import Session

from app.core.request_context import current_request_id
from app.database.models import AuditEvent, User


def record_audit_event(
    db: Session,
    *,
    company_id: uuid.UUID | None,
    user_id: uuid.UUID | None,
    action: str,
    object_type: str,
    object_id: str,
    data: dict | None = None,
) -> None:
    db.add(
        AuditEvent(
            company_id=company_id,
            user_id=user_id,
            action=action,
            object_type=object_type,
            object_id=object_id,
            data=data or {},
            request_id=current_request_id(),
        )
    )


def list_company_audit_events(
    db: Session,
    company_id: uuid.UUID,
    *,
    object_type: str | None,
    user_id: uuid.UUID | None,
    before: tuple[datetime, uuid.UUID] | None,
    limit: int | None,
) -> list[tuple[AuditEvent, User | None]]:
    """Newest first. `before` is the (created_at, id) of the last event of the previous page;
    `limit=None` returns every event (the CSV export)."""
    stmt = (
        select(AuditEvent, User)
        .outerjoin(User, AuditEvent.user_id == User.id)
        .where(AuditEvent.company_id == company_id)
    )
    if object_type:
        stmt = stmt.where(AuditEvent.object_type == object_type)
    if user_id:
        stmt = stmt.where(AuditEvent.user_id == user_id)
    if before:
        stmt = stmt.where(tuple_(AuditEvent.created_at, AuditEvent.id) < tuple_(*before))
    rows = db.execute(
        stmt.order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc()).limit(limit)
    ).all()
    return [(event, user) for event, user in rows]
