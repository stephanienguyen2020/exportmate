import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Response
from sqlalchemy.orm import Session

from app.core.auth import EditorContext, ViewerContext
from app.core.config import get_settings
from app.core.rate_limit import RateLimiter
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.reports import (
    ReportCreateIn,
    ReportDraftOut,
    ReportDraftSummaryOut,
    ReportEmailIn,
    ReportEmailOut,
    ReportUpdateIn,
)
from app.services import reports as report_service

router = APIRouter(prefix="/reports", tags=["reports"])
Db = Annotated[Session, Depends(get_db)]
report_email_limiter = RateLimiter("report emails")


@router.post("", response_model=SuccessResponse[ReportDraftOut], status_code=201)
def create_report(
    body: ReportCreateIn,
    ctx: ViewerContext,
    db: Db,
    authorization: Annotated[str | None, Header()] = None,
):
    """Generates an order or company report into a draft only its author sees and edits.
    A company report reads News watch with the caller's token."""
    return success_response(report_service.create_report_draft(db, ctx, body, authorization))


@router.get("", response_model=SuccessResponse[list[ReportDraftSummaryOut]])
def list_reports(ctx: ViewerContext, db: Db):
    """The caller's most recent drafts and sent reports."""
    return success_response(report_service.list_report_drafts(db, ctx))


@router.get("/{report_id}", response_model=SuccessResponse[ReportDraftOut])
def get_report(report_id: uuid.UUID, ctx: ViewerContext, db: Db):
    return success_response(report_service.get_report_draft(db, ctx, report_id))


@router.patch("/{report_id}", response_model=SuccessResponse[ReportDraftOut])
def update_report(report_id: uuid.UUID, body: ReportUpdateIn, ctx: ViewerContext, db: Db):
    """Replaces the draft's content. Lines are left out with included=false, not deleted."""
    return success_response(report_service.update_report_draft(db, ctx, report_id, body.content))


@router.get("/{report_id}/pdf", response_class=Response)
def download_report_pdf(report_id: uuid.UUID, ctx: ViewerContext, db: Db, download: bool = False):
    """The draft as it stands, for the preview (inline) or to save (?download=true)."""
    pdf, filename = report_service.render_report_draft(db, ctx, report_id)
    disposition = "attachment" if download else "inline"
    return Response(
        pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'{disposition}; filename="{filename}"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/{report_id}/email", response_model=SuccessResponse[ReportEmailOut])
def email_report(
    report_id: uuid.UUID,
    body: ReportEmailIn,
    ctx: EditorContext,
    db: Db,
    idempotency_key: Annotated[str | None, Header(max_length=100)] = None,
):
    """Emails the draft's PDF to up to five addresses, then locks the draft."""
    report_email_limiter.check(str(ctx.user.id), get_settings().report_emails_per_hour)
    return success_response(
        report_service.email_report_draft(
            db,
            ctx,
            report_id,
            recipients=body.to,
            message=body.message,
            idempotency_key=idempotency_key,
        )
    )
