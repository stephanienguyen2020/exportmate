"""HS codes: the official headings we search, and the codes AI suggests for orders without one."""

import enum
import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.gemini import EMBEDDING_DIMENSIONS
from app.database.models.base import Base, created_column, id_column, pg_enum


class HsHeading(Base):
    """A 4-digit heading or 6-digit subheading of the official tariff (seed_data/hs_headings.json).

    `embedding` is the description's vector (Gemini embeddings), so a product name finds the
    headings that mean the same thing in other words. Null until embedded; search then falls back
    to word similarity."""

    __tablename__ = "hs_headings"
    code: Mapped[str] = mapped_column(String(7), primary_key=True)  # "1234" or "1234.56"
    digits: Mapped[str] = mapped_column(String(6), unique=True, nullable=False)  # "123456"
    level: Mapped[int] = mapped_column(Integer, nullable=False)  # 4 or 6
    description: Mapped[str] = mapped_column(Text, nullable=False)  # the line's full path
    # Hash of the embedded text: a changed description is embedded again.
    text_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(EMBEDDING_DIMENSIONS))
    __table_args__ = (
        Index(
            "ix_hs_headings_description_trgm",
            "description",
            postgresql_using="gin",
            postgresql_ops={"description": "gin_trgm_ops"},
        ),
    )


class HsSuggestionStatus(str, enum.Enum):
    pending = "pending"
    accepted = "accepted"
    rejected = "rejected"


class HsCodeSuggestion(Base):
    __tablename__ = "hs_code_suggestions"
    id: Mapped[uuid.UUID] = id_column()
    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False
    )
    order_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("orders.id", ondelete="CASCADE"), index=True, nullable=False
    )
    hs_code: Mapped[str] = mapped_column(String(20), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)  # the official wording
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    # What it was based on: [{"type": "order", "ref": "PO-2291", "text": …, "hsCode": …} |
    # {"type": "heading", "ref": "1234.56", "text": …}]
    based_on: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    status: Mapped[HsSuggestionStatus] = mapped_column(
        pg_enum(HsSuggestionStatus, "hs_suggestion_status"),
        nullable=False,
        default=HsSuggestionStatus.pending,
    )
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = created_column()
    decided_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
