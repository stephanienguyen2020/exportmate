"""The company's audit log (owner only), and the public contact form."""

import base64
import binascii
import html
import json
import logging
import uuid
from datetime import datetime

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.context import CompanyContext
from app.core.email import OutgoingEmail, get_email_sender
from app.core.errors import AppError
from app.database.queries import audit as audit_queries
from app.schemas.audit import AuditEventOut, AuditUserOut, ContactIn

log = logging.getLogger(__name__)


def _encode_cursor(created_at: datetime, event_id: uuid.UUID) -> str:
    payload = json.dumps([created_at.isoformat(), str(event_id)])
    return base64.urlsafe_b64encode(payload.encode()).decode()


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        created_at, event_id = json.loads(base64.urlsafe_b64decode(cursor.encode()))
        return datetime.fromisoformat(created_at), uuid.UUID(event_id)
    except (binascii.Error, ValueError, TypeError):
        raise AppError(422, "invalid_cursor", "Invalid cursor.", {"cursor": "Invalid cursor"})


def list_audit_events(
    db: Session,
    ctx: CompanyContext,
    *,
    object_type: str | None,
    user_id: uuid.UUID | None,
    cursor: str | None,
    limit: int,
) -> tuple[list[AuditEventOut], str | None]:
    """Who did what, newest first, one page at a time."""
    rows = audit_queries.list_company_audit_events(
        db,
        ctx.company_id,
        object_type=object_type,
        user_id=user_id,
        before=_decode_cursor(cursor) if cursor else None,
        limit=limit + 1,
    )
    page = rows[:limit]
    next_cursor = (
        _encode_cursor(page[-1][0].created_at, page[-1][0].id) if len(rows) > limit else None
    )
    return [
        AuditEventOut(
            id=event.id,
            action=event.action,
            object_type=event.object_type,
            object_id=event.object_id,
            data=event.data,
            user=AuditUserOut(id=user.id, name=user.name, email=user.email) if user else None,
            request_id=event.request_id,
            created_at=event.created_at,
        )
        for event, user in page
    ], next_cursor


def send_contact_message(payload: ContactIn) -> bool:
    """Email the message to the ExportMate team (CONTACT_INBOX). Returns False when the hidden
    field was filled (a bot): the visitor is told it was received, nothing is sent."""
    inbox = get_settings().contact_inbox
    if not inbox:
        raise AppError(503, "contact_unavailable", "The contact form is not set up yet.")
    if payload.website.strip():
        log.info("contact.spam_dropped")
        return False
    company = f" ({payload.company.strip()})" if payload.company and payload.company.strip() else ""
    text = (
        f"From: {payload.name}{company} <{payload.email}>\n\n{payload.message}\n\n"
        "Sent from the contact form on the ExportMate site. Reply to answer them."
    )
    message_html = "<br>".join(html.escape(line) for line in payload.message.splitlines())
    receipt = get_email_sender().send_email(
        OutgoingEmail(
            to=[inbox],
            # Visitor text, one line.
            subject=" ".join(f"ExportMate contact: {payload.name}{company}".split())[:200],
            html=(
                f"<p><strong>{html.escape(payload.name)}{html.escape(company)}</strong> "
                f"&lt;{html.escape(payload.email)}&gt;</p><p>{message_html}</p>"
                "<p><small>Sent from the contact form on the ExportMate site. Reply to answer "
                "them.</small></p>"
            ),
            text=text,
            reply_to=payload.email,
        )
    )
    # Never the visitor's name, address or message.
    log.info(
        "contact.received",
        extra={"sandbox": receipt.sandbox, "message_chars": len(payload.message)},
    )
    return True
