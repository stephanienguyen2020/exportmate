import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database.models.base import Base, created_column, id_column


class PlaybookRule(Base):
    __tablename__ = "playbook_rules"
    id: Mapped[uuid.UUID] = id_column()
    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), index=True, nullable=False
    )
    text: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(String(50), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = created_column()
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PlaybookRevision(Base):
    """Snapshot of all live rules after each change. Never edited after insert."""

    __tablename__ = "playbook_revisions"
    id: Mapped[uuid.UUID] = id_column()
    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False)
    rules: Mapped[list] = mapped_column(JSONB, nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = created_column()
    __table_args__ = (UniqueConstraint("company_id", "revision"),)
