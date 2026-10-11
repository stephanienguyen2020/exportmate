import uuid

from sqlalchemy.orm import Session

from app.core.request_context import current_request_id
from app.database.models import AuditEvent


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
