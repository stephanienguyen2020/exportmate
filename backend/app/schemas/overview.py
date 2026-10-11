from datetime import date, datetime

from app.schemas.common import CamelCaseModel


class OverviewOut(CamelCaseModel):
    total_orders: int
    counts_by_status: dict[str, int]  # every status present, 0 if none
    value_at_risk_by_currency: dict[str, int]  # sum of exposed order values, minor units
    nearest_affected_ship_date: date | None
    sources_checked_at: datetime | None  # phase 2
