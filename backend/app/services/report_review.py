"""What can be done with an analysis report: the owner's review, feedback, and whether a supplier
message may be drafted from it (docs/REQUIREMENTS.md §4.6, §4.7)."""

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.core.context import CompanyContext
from app.core.errors import AppError, not_found_error
from app.database.models import AnalysisReport, ReportState, User
from app.database.queries import analysis as analysis_queries
from app.database.queries import audit as audit_queries
from app.database.queries import supplier_messages as message_queries
from app.schemas.analysis import (
    PersonOut,
    ReportContentOut,
    ReportFeedbackIn,
    ReportFeedbackOut,
    ReportReviewOut,
)

log = logging.getLogger(__name__)
GAP_STATUSES = {"missing", "mismatch"}


def message_blocked_reason(db: Session, report: AnalysisReport) -> str | None:
    """Why no supplier message can be drafted from this report, or None when one can."""
    content = ReportContentOut.model_validate(report.content)
    latest = analysis_queries.get_latest_order_report(db, report.order_id)
    if latest and latest.id != report.id:
        return "A newer analysis of this order exists: draft from that one."
    if report.blocked:
        return "A playbook rule blocks messages from this report."
    if report.state == ReportState.needs_data:
        return "Complete the order's data first, then run the analysis again."
    if report.state == ReportState.rejected or not content.audit.passed:
        return "The report failed its checks: run the analysis again."
    if report.state == ReportState.needs_human_review and report.reviewed_at is None:
        return "Waiting for the owner's review."
    if not any(f.status in GAP_STATUSES for f in content.findings):
        return "Nothing to ask the supplier for: no document is missing or wrong."
    return None


def _person(db: Session, user_id: uuid.UUID) -> PersonOut:
    user = db.get(User, user_id)
    return PersonOut(id=user.id, name=user.name or user.email)


def review_out(db: Session, report: AnalysisReport) -> ReportReviewOut | None:
    if report.reviewed_at is None:
        return None
    return ReportReviewOut(
        reviewed_by=_person(db, report.reviewed_by),
        reviewed_at=report.reviewed_at,
        note=report.review_note,
    )


def feedback_out(db: Session, ctx: CompanyContext, report_id: uuid.UUID) -> ReportFeedbackOut:
    useful, not_useful = message_queries.count_report_feedback(db, report_id)
    mine = message_queries.get_user_report_feedback(db, report_id, ctx.user.id)
    return ReportFeedbackOut(
        useful=useful,
        not_useful=not_useful,
        mine=mine.useful if mine else None,
        my_note=mine.note if mine else None,
    )


def review_report(
    db: Session, ctx: CompanyContext, report_id: uuid.UUID, note: str | None
) -> AnalysisReport:
    """The owner clears a report a playbook rule sent to them, so it can lead to a message."""
    report = analysis_queries.get_company_report(db, ctx.company_id, report_id, for_update=True)
    if not report:
        raise not_found_error("Report")
    if report.state != ReportState.needs_human_review:
        raise AppError(409, "no_review_needed", "This report doesn't need the owner's review.")
    if not ReportContentOut.model_validate(report.content).audit.passed:
        raise AppError(
            409,
            "report_failed_checks",
            "The report failed its checks, so a review can't clear it. Run the analysis again.",
        )
    if report.reviewed_at is not None:
        raise AppError(409, "already_reviewed", "This report was already reviewed.")
    report.reviewed_by = ctx.user.id
    report.reviewed_at = datetime.now(UTC)
    report.review_note = (note or "").strip() or None
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action="report.reviewed",
        object_type="analysis_report",
        object_id=str(report.id),
        data={"note": report.review_note},
    )
    db.commit()
    log.info(
        "report.reviewed", extra={"company_id": str(ctx.company_id), "report_id": str(report.id)}
    )
    return report


def give_feedback(
    db: Session, ctx: CompanyContext, report_id: uuid.UUID, payload: ReportFeedbackIn
) -> ReportFeedbackOut:
    report = analysis_queries.get_company_report(db, ctx.company_id, report_id)
    if not report:
        raise not_found_error("Report")
    note = (payload.note or "").strip() or None
    message_queries.upsert_report_feedback(
        db,
        {
            "company_id": ctx.company_id,
            "report_id": report.id,
            "user_id": ctx.user.id,
            "useful": payload.useful,
            "note": note,
        },
    )
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action="report.feedback",
        object_type="analysis_report",
        object_id=str(report.id),
        data={"useful": payload.useful, "note": note},
    )
    db.commit()
    log.info(
        "report.feedback",
        extra={
            "company_id": str(ctx.company_id),
            "report_id": str(report.id),
            "useful": payload.useful,
        },
    )
    return feedback_out(db, ctx, report.id)
