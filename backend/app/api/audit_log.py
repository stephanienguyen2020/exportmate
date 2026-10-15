import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.core.auth import OwnerContext
from app.core.config import get_settings
from app.core.rate_limit import RateLimiter
from app.database.session import get_db
from app.schemas.audit import AuditEventOut, ContactIn
from app.schemas.common import SuccessResponse, success_response
from app.services import audit_log as audit_service

router = APIRouter(tags=["audit log and contact"])
Db = Annotated[Session, Depends(get_db)]
contact_limiter = RateLimiter("contact messages")


@router.get("/audit-events", response_model=SuccessResponse[list[AuditEventOut]])
def list_audit_events(
    ctx: OwnerContext,
    db: Db,
    object_type: Annotated[str | None, Query(alias="objectType", max_length=50)] = None,
    user_id: Annotated[uuid.UUID | None, Query(alias="userId")] = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
):
    """Who imported, edited, approved and sent what, and when; newest first."""
    events, next_cursor = audit_service.list_audit_events(
        db, ctx, object_type=object_type, user_id=user_id, cursor=cursor, limit=limit
    )
    return success_response(events, nextCursor=next_cursor)


def _visitor_ip(request: Request) -> str:
    """The first X-Forwarded-For address (set by Cloud Run's front end), else the peer."""
    forwarded = request.headers.get("X-Forwarded-For", "")
    return forwarded.split(",")[0].strip() or (request.client.host if request.client else "")


@router.post("/contact", response_model=SuccessResponse[dict], status_code=202)
def send_contact_message(payload: ContactIn, request: Request):
    """The public contact form: emailed to the ExportMate team. No sign-in."""
    contact_limiter.check(_visitor_ip(request), get_settings().contact_messages_per_hour)
    audit_service.send_contact_message(payload)
    return success_response({"received": True})
