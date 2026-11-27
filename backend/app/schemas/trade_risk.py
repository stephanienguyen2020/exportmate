from datetime import datetime
from typing import Literal

from pydantic import Field

from app.schemas.common import CamelCaseModel

TradeRiskStatus = Literal["scored", "pending", "no_data"]
TradeRiskLevel = Literal["high", "medium", "low"]


class TradeRiskReasonOut(CamelCaseModel):
    feature: str
    text: str


class SimilarTradeCaseOut(CamelCaseModel):
    case_id: str
    kind: str  # AD (anti-dumping) or CVD (anti-subsidy)
    market: str
    exporter: str
    hs6: str  # HS 2012
    year: int
    product: str | None
    outcome: Literal["duty imposed", "pending", "no duty"]
    duty_pct: float | None


class TradeRiskOut(CamelCaseModel):
    """The risk that `market` opens an anti-dumping or anti-subsidy case against `exporter` on
    the product in the next 12 months. `pending`: no score yet, the job was started (or the
    monthly run will score it); ask again shortly. `no_data`: `note` says why."""

    order_id: str | None = None
    market: str | None  # alpha-2, or EU / EAEU / GCC
    exporter: str | None  # alpha-2
    hs6: str | None
    status: TradeRiskStatus
    level: TradeRiskLevel | None = None
    # Probability of a case in the next 12 months; small even when high (about 1 in 900 rows).
    score: float | None = None
    # Share of the model's reference rows (every flow of the latest year) that scored lower.
    percentile: float | None = None
    reasons: list[TradeRiskReasonOut] = Field(default_factory=list)
    note: str | None = None
    backfill_started: bool = False
    model_version: str | None = None
    data_from: str | None = None  # "2025-09" (Comtrade months) or "2024" (BACI year)
    data_to: str | None = None
    data_source: Literal["comtrade", "baci"] | None = None
    scored_at: datetime | None = None
    similar_cases: list[SimilarTradeCaseOut] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)
