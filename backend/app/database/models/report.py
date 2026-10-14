import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database.models.base import Base, created_column, id_column, pg_enum


class ReportKind(str, enum.Enum):
    order = "order"  # one order's checklist
    company = "company"  # what is happening and what it affects, across the company


class ReportDraft(Base):
    """A report its author can edit before sending. `original` is what the system generated;
    `content` is the edited copy, and the PDF marks every line that differs from the original.
    Once sent it is locked, so it stays exactly what the recipients got."""

    __tablename__ = "report_drafts"
    id: Mapped[uuid.UUID] = id_column()
    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), index=True, nullable=False
    )
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    kind: Mapped[ReportKind] = mapped_column(pg_enum(ReportKind, "report_kind"), nullable=False)
    scope: Mapped[dict] = mapped_column(JSONB, nullable=False)  # {"orderId"} or {"days"}
    original: Mapped[dict] = mapped_column(JSONB, nullable=False)
    content: Mapped[dict] = mapped_column(JSONB, nullable=False)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sent_to: Mapped[list[str] | None] = mapped_column(ARRAY(String(254)))
    created_at: Mapped[datetime] = created_column()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
