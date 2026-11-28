"""Trade defence risk: the figures, features, scores and past cases of (market, exporter, HS 6) pairs.

Written only by the Order features job (`ml/trade_risk/order_features.py`); the backend reads them.
Countries are ISO alpha-2 codes; a customs union that opens cases as one market is "EU", "EAEU" or
"GCC". `hs6` is the order's HS code (first 6 digits); `model_hs6` is the HS 2012 code the model and
the case list use for it. Design: ml/docs/TRADE_DEFENCE_RISK_MODEL.md.
"""

import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Float, ForeignKey, Index, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database.models.base import Base, created_column, id_column


class OrderTradePair(Base):
    """Which pair each order needs: written by the backend when an order is saved, edited or
    imported, deleted with the order. Matched to the other tables by value (market, exporter,
    hs6), not by key: a new pair has no score yet, and scores keep one row per scoring. The Order
    features job scores the pairs here that have no score, and refreshes them monthly."""

    __tablename__ = "order_trade_pairs"
    order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("orders.id", ondelete="CASCADE"), primary_key=True
    )
    market: Mapped[str] = mapped_column(String(4), nullable=False)
    exporter: Mapped[str] = mapped_column(String(2), nullable=False)
    hs6: Mapped[str] = mapped_column(String(6), nullable=False)
    __table_args__ = (Index("ix_order_trade_pairs_pair", "market", "exporter", "hs6"),)


class ImportFigure(Base):
    """A market's imports of a product from one exporter in one period: a Comtrade month, or a
    BACI year where Comtrade has no recent 12 months. Kept to trace a score to its figures; shown
    to no one (Comtrade's terms: scores and reasons only)."""

    __tablename__ = "import_figures"
    market: Mapped[str] = mapped_column(String(4), primary_key=True)
    exporter: Mapped[str] = mapped_column(String(2), primary_key=True)
    hs6: Mapped[str] = mapped_column(String(6), primary_key=True)
    period: Mapped[str] = mapped_column(String(7), primary_key=True)  # "2026-08" or "2024"
    source: Mapped[str] = mapped_column(String(10), primary_key=True)  # comtrade or baci
    period_kind: Mapped[str] = mapped_column(String(5), nullable=False)  # month or year
    value_usd: Mapped[float] = mapped_column(Float, nullable=False)
    tonnes: Mapped[float | None] = mapped_column(Float)
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class TradeFlowFeatures(Base):
    """The model's features for a pair, from its latest 12 months of figures."""

    __tablename__ = "trade_flow_features"
    market: Mapped[str] = mapped_column(String(4), primary_key=True)
    exporter: Mapped[str] = mapped_column(String(2), primary_key=True)
    hs6: Mapped[str] = mapped_column(String(6), primary_key=True)
    model_hs6: Mapped[str] = mapped_column(String(6), nullable=False)
    # Feature name -> value (null when it can't be computed, e.g. no tonnes reported).
    features: Mapped[dict] = mapped_column(JSONB, nullable=False)
    data_from: Mapped[str] = mapped_column(String(7), nullable=False)
    data_to: Mapped[str] = mapped_column(String(7), nullable=False)
    data_source: Mapped[str] = mapped_column(String(10), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class TradeRiskScore(Base):
    """One scoring of a pair. Rows are only added: the latest per pair is the answer, and earlier
    ones show what we warned before a case opened."""

    __tablename__ = "trade_risk_scores"
    id: Mapped[uuid.UUID] = id_column()
    market: Mapped[str] = mapped_column(String(4), nullable=False)
    exporter: Mapped[str] = mapped_column(String(2), nullable=False)
    hs6: Mapped[str] = mapped_column(String(6), nullable=False)
    model_hs6: Mapped[str | None] = mapped_column(String(6))
    # high, medium, low, or no_data (no recent figures, or a flow too small to score).
    level: Mapped[str] = mapped_column(String(10), nullable=False)
    score: Mapped[float | None] = mapped_column(Float)
    # How the score ranks: the share of the model's reference rows scored lower (0-1).
    percentile: Mapped[float | None] = mapped_column(Float)
    # [{"feature", "text", "contribution"}], the features that raised the score most.
    reasons: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    # Why there is no score, for no_data.
    note: Mapped[str | None] = mapped_column(Text)
    model_version: Mapped[str] = mapped_column(String(40), nullable=False)
    data_from: Mapped[str | None] = mapped_column(String(7))
    data_to: Mapped[str | None] = mapped_column(String(7))
    data_source: Mapped[str | None] = mapped_column(String(10))
    scored_at: Mapped[datetime] = created_column()
    __table_args__ = (Index("ix_trade_risk_scores_pair", "market", "exporter", "hs6", "scored_at"),)


class TradeCase(Base):
    """A past anti-dumping or anti-subsidy case on one product (HS 2012), for similar past cases.
    From the World Bank Temporary Trade Barriers Database and the US Federal Register."""

    __tablename__ = "trade_cases"
    case_id: Mapped[str] = mapped_column(String(80), primary_key=True)
    market: Mapped[str] = mapped_column(String(4), primary_key=True)
    exporter: Mapped[str] = mapped_column(String(2), primary_key=True)
    hs6: Mapped[str] = mapped_column(String(6), primary_key=True)
    kind: Mapped[str] = mapped_column(String(3), nullable=False)  # AD or CVD
    opened_on: Mapped[date] = mapped_column(Date, nullable=False)
    final_measure_on: Mapped[date | None] = mapped_column(Date)
    revoked_on: Mapped[date | None] = mapped_column(Date)
    measure_status: Mapped[str | None] = mapped_column(String(30))
    duty_pct: Mapped[float | None] = mapped_column(Float)
    product: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(20), nullable=False)
    __table_args__ = (
        Index("ix_trade_cases_market_hs6", "market", "hs6"),
        Index("ix_trade_cases_hs6", "hs6"),
    )


class MeasureScore(Base):
    """One scoring of one row of a trade measure a news article reports: how harsh it is for that
    market, exporting country and product (the harshness model, ml/trade_risk/harshness_scoring.py).
    The news scan writes the measure down once per article (Firestore `articles`, `measure`) and
    starts the Order features job with it; rows are only added. Every company's alert about the
    article reads the same rows. Design: ml/docs/HARSHNESS_MODEL.md."""

    __tablename__ = "measure_scores"
    id: Mapped[uuid.UUID] = id_column()
    article_id: Mapped[str] = mapped_column(String(40), nullable=False)
    # The scan's words: anti_dumping, anti_subsidy, safeguard (the model's kinds); petition, opening, ...
    kind: Mapped[str] = mapped_column(String(20), nullable=False)
    stage: Mapped[str] = mapped_column(String(20), nullable=False)
    market: Mapped[str] = mapped_column(String(4), nullable=False)
    exporter: Mapped[str] = mapped_column(String(2), nullable=False)
    hs6: Mapped[str] = mapped_column(String(6), nullable=False)
    model_hs6: Mapped[str | None] = mapped_column(String(6))
    # high, medium, low, or no_data (no recent figures, or a flow too small to score).
    level: Mapped[str] = mapped_column(String(10), nullable=False)
    # The model's probability that the exporter's imports into the market fall by half against
    # the rest of the market within 2 years.
    score: Mapped[float | None] = mapped_column(Float)
    reasons: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    note: Mapped[str | None] = mapped_column(Text)
    # model, or gemini for the kinds the model doesn't cover.
    scored_by: Mapped[str] = mapped_column(String(10), nullable=False)
    model_version: Mapped[str] = mapped_column(String(40), nullable=False)
    data_from: Mapped[str | None] = mapped_column(String(7))
    data_to: Mapped[str | None] = mapped_column(String(7))
    data_source: Mapped[str | None] = mapped_column(String(10))
    scored_at: Mapped[datetime] = created_column()
    __table_args__ = (
        Index("ix_measure_scores_article", "article_id", "scored_at"),
        Index("ix_measure_scores_pair", "market", "exporter", "hs6"),
    )
