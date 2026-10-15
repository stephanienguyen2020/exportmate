"""A what-if a person saved from the trade map: another market, ship date or route for one order,
with their note. Saving changes nothing about the order; it is a proposal on record.

`comparison` is the comparison as it stood when saved (MarketComparisonOut), so the note keeps
the context it was written in even after the checklist or the supplier's documents change.
"""

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database.models.base import Base, created_column, id_column, pg_enum


class ScenarioKind(str, enum.Enum):
    market = "market"
    ship_date = "ship_date"
    route = "route"


class OrderScenario(Base):
    __tablename__ = "order_scenarios"
    id: Mapped[uuid.UUID] = id_column()
    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), nullable=False
    )
    order_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("orders.id", ondelete="CASCADE"), index=True, nullable=False
    )
    kind: Mapped[ScenarioKind] = mapped_column(
        pg_enum(ScenarioKind, "scenario_kind"), nullable=False
    )
    # A market code ("US"), an ISO date, or a route code ("SG", "direct").
    target: Mapped[str] = mapped_column(String(32), nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    comparison: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    updated_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = created_column()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
    __table_args__ = (UniqueConstraint("company_id", "order_id", "kind", "target"),)
