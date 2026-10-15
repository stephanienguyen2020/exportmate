"""A person's verdict on whether a News watch alert affects one of the company's orders.

Alerts live in the AI service (Firestore), so a review keeps the alert's ID and a copy of its
headline and link: the alert can age out of News watch while the verdict stays on record.
"""

import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database.models.base import Base, id_column, pg_enum


class NewsVerdict(str, enum.Enum):
    relevant = "relevant"
    not_relevant = "not_relevant"


class NewsOrderReview(Base):
    __tablename__ = "news_order_reviews"
    id: Mapped[uuid.UUID] = id_column()
    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False
    )
    impact_id: Mapped[str] = mapped_column(String(128), nullable=False)
    order_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("orders.id", ondelete="CASCADE"), index=True, nullable=False
    )
    verdict: Mapped[NewsVerdict] = mapped_column(
        pg_enum(NewsVerdict, "news_verdict"), nullable=False
    )
    note: Mapped[str | None] = mapped_column(Text)
    # False when a reviewer linked an order ExportMate didn't suggest.
    suggested: Mapped[bool] = mapped_column(Boolean, nullable=False)
    reason: Mapped[str] = mapped_column(String(500), nullable=False)
    headline: Mapped[str] = mapped_column(String(500), nullable=False)
    url: Mapped[str | None] = mapped_column(String(2000))
    reviewed_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    reviewed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    __table_args__ = (UniqueConstraint("company_id", "impact_id", "order_id"),)
