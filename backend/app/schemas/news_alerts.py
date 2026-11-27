from typing import Any, Literal

from app.schemas.common import CamelCaseModel


class NewsAlertsOut(CamelCaseModel):
    """The newest alerts about the caller's goods and the latest scan, as the news
    scan stored them (their fields are the scan's, passed through as they are)."""

    impacts: list[dict[str, Any]]
    scan: dict[str, Any] | None


class StockOwnerOut(CamelCaseModel):
    company: str
    about: str


class NewsGoodsOut(CamelCaseModel):
    """What News watch reads the news against: a company's own goods (what its profile names
    and its orders ship, without quantities or values), or the demo's sample stock.
    `watched_since`: when the scan first read news for the company's goods (None: from the
    next scan)."""

    kind: Literal["company", "sample"]
    items: list[dict[str, Any]]
    owner: StockOwnerOut
    updated_at: str | None = None
    watched_since: str | None = None
