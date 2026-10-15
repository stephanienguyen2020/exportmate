import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database.models import AnalysisReport, AnalysisRun, Order


def add_run(db: Session, run: AnalysisRun) -> AnalysisRun:
    db.add(run)
    db.flush()
    return run


def get_company_run(db: Session, company_id: uuid.UUID, run_id: uuid.UUID) -> AnalysisRun | None:
    return db.scalar(
        select(AnalysisRun).where(AnalysisRun.id == run_id, AnalysisRun.company_id == company_id)
    )


def add_reports(db: Session, reports: list[AnalysisReport]) -> None:
    db.add_all(reports)
    db.flush()


def list_run_reports(db: Session, run_id: uuid.UUID) -> list[tuple[AnalysisReport, str]]:
    """(report, the order's own ID), in order ID order."""
    rows = db.execute(
        select(AnalysisReport, Order.external_id)
        .join(Order, AnalysisReport.order_id == Order.id)
        .where(AnalysisReport.run_id == run_id)
        .order_by(Order.external_id)
    ).all()
    return [(report, external_id) for report, external_id in rows]


def get_company_report(
    db: Session, company_id: uuid.UUID, report_id: uuid.UUID, *, for_update: bool = False
) -> AnalysisReport | None:
    stmt = select(AnalysisReport).where(
        AnalysisReport.id == report_id, AnalysisReport.company_id == company_id
    )
    if for_update:
        stmt = stmt.with_for_update()
    return db.scalar(stmt)


def get_latest_order_report(db: Session, order_id: uuid.UUID) -> AnalysisReport | None:
    return db.scalar(
        select(AnalysisReport)
        .where(AnalysisReport.order_id == order_id)
        .order_by(AnalysisReport.created_at.desc(), AnalysisReport.id.desc())
        .limit(1)
    )
