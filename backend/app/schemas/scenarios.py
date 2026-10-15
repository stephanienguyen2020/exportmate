import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.analysis import PersonOut
from app.schemas.common import CamelCaseModel
from app.schemas.trade_map import MarketComparisonOut

ScenarioKindName = Literal["market", "ship_date", "route"]


class ScenarioTargetIn(CamelCaseModel):
    order_id: str = Field(min_length=1, max_length=100)  # the order's external ID
    kind: ScenarioKindName
    # A market code ("US"), an ISO date ("2026-12-03"), or a route ("SG", "direct").
    target: str = Field(min_length=2, max_length=32)


class ScenarioIn(ScenarioTargetIn):
    note: str | None = Field(default=None, max_length=2000)


class ScenarioNoteIn(CamelCaseModel):
    note: str | None = Field(default=None, max_length=2000)


class ScenarioOut(CamelCaseModel):
    id: uuid.UUID
    order_id: str
    kind: ScenarioKindName
    target: str
    label: str  # "Route via Singapore", "Market: United States", "Ship date 2026-12-03"
    note: str | None
    comparison: MarketComparisonOut  # as it stood when saved
    created_by: PersonOut | None
    updated_by: PersonOut | None
    created_at: datetime
    updated_at: datetime


class ScenarioPointOut(CamelCaseModel):
    text: str
    items: list[str]  # titles of the comparison lines it rests on


class ScenarioSuggestionOut(CamelCaseModel):
    """An AI reading of one comparison, for the person to edit into their note. Not saved."""

    summary: str
    next_steps: list[ScenarioPointOut]
    questions: list[ScenarioPointOut]  # for the buyer or supplier: what the data can't answer
    note: str  # summary, steps and questions as one plain-text note


class SuggestedPoint(BaseModel):
    text: str
    items: list[str]


class SuggestedScenarioNote(BaseModel):
    """The AI's answer (checked in code before it is shown)."""

    summary: str
    next_steps: list[SuggestedPoint]
    questions: list[SuggestedPoint]
