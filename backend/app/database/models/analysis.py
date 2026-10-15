"""Analysis: runs, and the report each run writes per order.

A run checks orders against the market requirements (the same check as the trade
map), prices what's missing, applies the company's checked playbook rules, suggests one action
and audits the result. Reports keep a copy of everything they cite, so they still read the same
after a requirement, a rule or a cost setting changes.
"""

import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database.models.base import Base, created_column, id_column, pg_enum
from app.database.models.order import OrderStatus


class RunStatus(str, enum.Enum):
    running = "running"
    done = "done"
    failed = "failed"


class ReportState(str, enum.Enum):
    passed = "pass"  # every claim cited, every number re-computes
    # Retired: reports with missing data are `pass` (or wait for review) and list it in
    # `missingData`. Kept for reports made before.
    needs_data = "needs_data"
    rejected = "rejected"  # the auditor turned it down; it can't lead to a message
    needs_human_review = "needs_human_review"  # a playbook rule or the auditor asks for a person


class AnalysisRun(Base):
    __tablename__ = "analysis_runs"
    id: Mapped[uuid.UUID] = id_column()
    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), index=True, nullable=False
    )
    status: Mapped[RunStatus] = mapped_column(pg_enum(RunStatus, "run_status"), nullable=False)
    order_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # [{"name", "summary"}] in order: relevance, exposure, cost, playbook, plan, auditor.
    steps: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    playbook_revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cost_settings: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)  # as used
    error: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = created_column()
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AnalysisReport(Base):
    """What one run found for one order."""

    __tablename__ = "analysis_reports"
    id: Mapped[uuid.UUID] = id_column()
    run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("analysis_runs.id", ondelete="CASCADE"), index=True, nullable=False
    )
    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False
    )
    order_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("orders.id", ondelete="CASCADE"), nullable=False
    )
    state: Mapped[ReportState] = mapped_column(pg_enum(ReportState, "report_state"), nullable=False)
    order_status: Mapped[OrderStatus] = mapped_column(
        pg_enum(OrderStatus, "order_status"), nullable=False
    )
    blocked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # The owner's review of a `needs_human_review` report (a playbook rule asked for it); after
    # it the report can lead to a supplier message. A failed audit can't be reviewed away.
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    review_note: Mapped[str | None] = mapped_column(Text)
    # The schemas in schemas/analysis.py, stored as JSON so the report reads the same later.
    content: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = created_column()
    __table_args__ = (Index("ix_analysis_reports_order_latest", "order_id", "created_at"),)
