"""Messages to suppliers drafted from an analysis report, and feedback on reports.

A message is drafted by AI from a report, edited by an editor, approved by the owner (the exact
text is hashed) and sent once. Editing an approved message sends it back to draft. Sending never
clears the order's problem: new evidence and a new passing analysis do.
"""

import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database.models.base import Base, created_column, id_column, pg_enum


class SupplierMessageStatus(str, enum.Enum):
    draft = "draft"
    approved = "approved"  # the owner approved this exact text
    sent = "sent"
    failed = "failed"  # the email service refused it; can be sent again


class SupplierMessage(Base):
    __tablename__ = "supplier_messages"
    id: Mapped[uuid.UUID] = id_column()
    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), index=True, nullable=False
    )
    report_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("analysis_reports.id", ondelete="CASCADE"), index=True, nullable=False
    )
    order_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("orders.id", ondelete="CASCADE"), index=True, nullable=False
    )
    supplier_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("suppliers.id", ondelete="SET NULL")
    )
    status: Mapped[SupplierMessageStatus] = mapped_column(
        pg_enum(SupplierMessageStatus, "supplier_message_status"),
        nullable=False,
        default=SupplierMessageStatus.draft,
    )
    recipient: Mapped[str | None] = mapped_column(String(254))  # null until someone sets it
    subject: Mapped[str] = mapped_column(String(200), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = created_column()
    approved_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # SHA-256 of recipient, subject and body at approval: what is sent must match it.
    approved_hash: Mapped[str | None] = mapped_column(String(64))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sandbox: Mapped[bool | None] = mapped_column(Boolean)  # sent: True when nothing was delivered
    provider_message_id: Mapped[str | None] = mapped_column(String(200))
    error: Mapped[str | None] = mapped_column(Text)  # why the last send failed


class ReportFeedback(Base):
    """One person's verdict on an analysis report: useful or not, and why."""

    __tablename__ = "report_feedback"
    id: Mapped[uuid.UUID] = id_column()
    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False
    )
    report_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("analysis_reports.id", ondelete="CASCADE"), index=True, nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    useful: Mapped[bool] = mapped_column(Boolean, nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_column()
    __table_args__ = (UniqueConstraint("report_id", "user_id"),)
