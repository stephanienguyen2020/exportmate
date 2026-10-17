import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import Field

from app.schemas.common import CamelCaseModel


class NewsReviewerOut(CamelCaseModel):
    id: uuid.UUID
    name: str


class NewsReviewOut(CamelCaseModel):
    verdict: Literal["relevant", "not_relevant"]
    note: str | None
    reviewed_by: NewsReviewerOut
    reviewed_at: datetime


class NewsPathStepOut(CamelCaseModel):
    """One step of the knowledge graph path that led to a suggestion."""

    kind: Literal["mention", "supplier", "product", "order"]
    label: str
    link: str | None  # how it follows from the step before, e.g. "used to make"
    source_title: str | None
    source_url: str | None
    quote: str | None


class NewsOrderMatchOut(CamelCaseModel):
    """One order a News watch alert may affect: suggested by ExportMate, linked by a person,
    or both, with the person's verdict once given."""

    impact_id: str
    order_id: str  # the order's external ID, as in /orders/{id}
    product: str
    destination: str
    market: str | None
    ship_date: date
    suggested: bool
    reason: str
    review: NewsReviewOut | None
    # How the graph reached the order; empty for an order a person linked.
    path: list[NewsPathStepOut] = Field(default_factory=list)


class NewsMatchesOut(CamelCaseModel):
    news_available: bool  # False when the AI service couldn't be reached
    matches: list[NewsOrderMatchOut]


class NewsReviewIn(CamelCaseModel):
    verdict: Literal["relevant", "not_relevant"]
    note: str | None = Field(default=None, max_length=500)
