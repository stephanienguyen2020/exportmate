import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.database.models import HsSuggestionStatus
from app.schemas.analysis import RunOut
from app.schemas.common import CamelCaseModel
from app.schemas.orders import OrderOut


class SuggestionBasisOut(CamelCaseModel):
    """Something the suggestion was based on: one of the company's past orders, or an official
    tariff line."""

    type: Literal["order", "heading"]
    ref: str  # "PO-2291" or "9403.60"
    text: str  # the order's product, or the heading's description
    hs_code: str | None = None  # for orders: the code it has


class HsSuggestionOut(CamelCaseModel):
    id: uuid.UUID
    hs_code: str
    description: str  # the official wording of the code
    reason: str  # why it fits this product
    based_on: list[SuggestionBasisOut]
    status: HsSuggestionStatus
    created_at: datetime
    decided_at: datetime | None


class HsSuggestionAcceptedOut(CamelCaseModel):
    suggestion: HsSuggestionOut
    order: OrderOut
    run: RunOut  # the order analysed again with its new code


class SuggestedCode(BaseModel):
    """One code as the AI returns it (checked in code before saving)."""

    hs_code: str
    reason: str
    based_on: list[str]  # refs from the candidates it was shown, e.g. "order:PO-2291"


class SuggestedCodes(BaseModel):
    codes: list[SuggestedCode]
