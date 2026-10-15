import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import Field

from app.database.models import PlaybookRule
from app.schemas.common import CamelCaseModel

Category = Literal["Policy", "Threshold", "Supplier", "Watchlist"]


class ConditionIn(CamelCaseModel):
    """One WHEN condition: a field, a comparison and a value (GET /playbook/fields lists them).
    Money values are {"amountMinor": 200000, "currency": "USD"}."""

    field: str = Field(max_length=40)
    op: str = Field(max_length=20)
    value: Any = None


class ActionIn(CamelCaseModel):
    action: str = Field(max_length=20)  # flag, owner_review, block
    note: str | None = None  # shown on the report, e.g. "Move the ship date"


class RuleOut(CamelCaseModel):
    id: uuid.UUID
    text: str
    category: str
    enabled: bool
    when: list[ConditionIn] | None  # None: stored only, not checked
    then: ActionIn | None
    checked: bool
    created_at: datetime

    @classmethod
    def from_rule(cls, rule: PlaybookRule) -> "RuleOut":
        return cls(
            id=rule.id,
            text=rule.text,
            category=rule.category,
            enabled=rule.enabled,
            when=rule.conditions,
            then=ActionIn(action=rule.action, note=rule.action_note) if rule.action else None,
            checked=bool(rule.conditions),
            created_at=rule.created_at,
        )


class RuleIn(CamelCaseModel):
    text: str = Field(min_length=1, max_length=500)
    category: Category
    enabled: bool = True
    when: list[ConditionIn] | None = Field(default=None, max_length=10)
    then: ActionIn | None = None


class RuleUpdate(CamelCaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=500)
    category: Category | None = None
    enabled: bool | None = None
    # Send both to make the rule checked, or both as null to make it stored only.
    when: list[ConditionIn] | None = Field(default=None, max_length=10)
    then: ActionIn | None = None


class FieldOut(CamelCaseModel):
    key: str
    label: str
    type: str  # text, hs_code, number, money, document_kinds
    ops: dict[str, str]  # comparison -> label
    options: list[dict[str, str]] | None  # [{"value", "label"}] for markets and document kinds


class RuleFieldsOut(CamelCaseModel):
    """What the rule form's dropdowns offer."""

    fields: list[FieldOut]
    actions: dict[str, str]  # action -> label
    no_value_ops: list[str]  # comparisons that take no value
