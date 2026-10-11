import uuid
from datetime import datetime
from typing import Literal

from pydantic import Field

from app.schemas.common import CamelCaseModel

Category = Literal["Policy", "Threshold", "Supplier", "Watchlist"]


class RuleOut(CamelCaseModel):
    id: uuid.UUID
    text: str
    category: str
    enabled: bool
    created_at: datetime


class RuleIn(CamelCaseModel):
    text: str = Field(min_length=1, max_length=500)
    category: Category
    enabled: bool = True


class RuleUpdate(CamelCaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=500)
    category: Category | None = None
    enabled: bool | None = None
