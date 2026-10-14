"""Checked playbook rules: WHEN every condition holds THEN an action.

A rule is data, not code: each condition is a field from FIELDS, a comparison that field allows,
and a value. One checker (`rule_fires`) runs every rule against the facts analysis computed for
an order, so a new rule never needs new code. Rules that need facts we don't have (margin) can't
be written here and stay stored only (docs/REQUIREMENTS.md §4.4).
"""

import re
from dataclasses import dataclass
from typing import Any

from app.core.currencies import is_currency

ACTIONS = {
    "flag": "Add a note to the report",
    "owner_review": "Send the report to the owner (needs human review)",
    "block": "Block messages from this report",
}

# Comparisons by value type, with the label the form shows.
OPS: dict[str, dict[str, str]] = {
    "text": {"equals": "is", "not_equals": "is not", "contains": "contains"},
    "hs_code": {"starts_with": "starts with", "equals": "is"},
    "number": {"less_than": "less than", "greater_than": "more than", "equals": "is"},
    "money": {"less_than": "less than", "greater_than": "more than"},
    "document_kinds": {
        "contains": "includes",
        "not_contains": "doesn't include",
        "is_empty": "is empty",
        "is_not_empty": "is not empty",
    },
}
NO_VALUE_OPS = {"is_empty", "is_not_empty"}


@dataclass(frozen=True)
class Field:
    label: str
    type: str  # a key of OPS
    options: str | None = None  # "markets" or "document_kinds": the form offers a list


FIELDS: dict[str, Field] = {
    "market": Field("Market", "text", options="markets"),
    "supplier": Field("Supplier", "text"),
    "hs_code": Field("HS code", "hs_code"),
    "order_value": Field("Order value", "money"),
    "days_until_ship": Field("Days until ship date", "number"),
    "missing_documents": Field("Missing documents", "document_kinds", options="document_kinds"),
    "estimated_cost": Field("Estimated cost of the problems (without duties)", "money"),
}

_HS = re.compile(r"^\d{2,10}$")


class RuleError(ValueError):
    """A condition that can't be checked; `field` is the JSON path, e.g. "when.0.value"."""

    def __init__(self, field: str, message: str):
        super().__init__(message)
        self.field = field
        self.message = message


def clean_conditions(
    conditions: list[dict], markets: set[str], document_kinds: set[str]
) -> list[dict]:
    """Check each {field, op, value} and return them in stored form, or raise RuleError."""
    if not conditions:
        raise RuleError("when", "Add at least one condition")
    cleaned = []
    for i, condition in enumerate(conditions):
        path = f"when.{i}"
        name, op, value = condition.get("field"), condition.get("op"), condition.get("value")
        field = FIELDS.get(name)
        if field is None:
            raise RuleError(f"{path}.field", f"Unknown field. Use one of: {', '.join(FIELDS)}")
        if op not in OPS[field.type]:
            raise RuleError(f"{path}.op", f"Use one of: {', '.join(OPS[field.type])}")
        if op in NO_VALUE_OPS:
            cleaned.append({"field": name, "op": op, "value": None})
            continue
        cleaned.append(
            {
                "field": name,
                "op": op,
                "value": _clean_value(path, field, name, value, markets, document_kinds),
            }
        )
    return cleaned


def _clean_value(
    path: str, field: Field, name: str, value: Any, markets: set[str], document_kinds: set[str]
) -> Any:
    where = f"{path}.value"
    if field.type == "text":
        if not isinstance(value, str) or not value.strip() or len(value) > 300:
            raise RuleError(where, "Text, 1 to 300 characters")
        if name == "market" and value.strip().upper() not in markets:
            raise RuleError(where, "Unknown market")
        return value.strip().upper() if name == "market" else value.strip()
    if field.type == "hs_code":
        digits = re.sub(r"\D", "", value) if isinstance(value, str) else ""
        if not _HS.match(digits):
            raise RuleError(where, "2 to 10 digits, e.g. 9403")
        return digits
    if field.type == "number":
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or not -100_000 <= value <= 100_000
        ):
            raise RuleError(where, "A whole number")
        return value
    if field.type == "money":
        if not isinstance(value, dict):
            raise RuleError(where, 'Money: {"amountMinor": 200000, "currency": "USD"}')
        amount, currency = value.get("amountMinor"), value.get("currency")
        if isinstance(amount, bool) or not isinstance(amount, int) or amount < 0:
            raise RuleError(where, "amountMinor: a whole number of hundredths, 0 or more")
        if not isinstance(currency, str) or not is_currency(currency.upper()):
            raise RuleError(where, "currency: an ISO 4217 code such as USD")
        return {"amountMinor": amount, "currency": currency.upper()}
    # document_kinds
    if value not in document_kinds:
        raise RuleError(where, "Unknown document kind")
    return value


def check_action(action: str | None, note: str | None) -> None:
    if action not in ACTIONS:
        raise RuleError("then.action", f"Use one of: {', '.join(ACTIONS)}")
    if note is not None and len(note) > 500:
        raise RuleError("then.note", "At most 500 characters")


def _compare(fact: Any, field: Field, op: str, value: Any) -> bool:
    if field.type == "text":
        text, wanted = (fact or "").casefold(), str(value).casefold()
        return {
            "equals": text == wanted,
            "not_equals": text != wanted,
            "contains": wanted in text,
        }[op]
    if field.type == "hs_code":
        digits = re.sub(r"\D", "", fact or "")
        return digits.startswith(value) if op == "starts_with" else digits == value
    if field.type == "number":
        if fact is None:
            return False
        return {"less_than": fact < value, "greater_than": fact > value, "equals": fact == value}[
            op
        ]
    if field.type == "money":
        # {currency: amount}; amounts in another currency are never compared (no conversion).
        amount = (fact or {}).get(value["currency"])
        if amount is None:
            return False
        return amount < value["amountMinor"] if op == "less_than" else amount > value["amountMinor"]
    kinds = set(fact or [])
    return {
        "contains": value in kinds,
        "not_contains": value not in kinds,
        "is_empty": not kinds,
        "is_not_empty": bool(kinds),
    }[op]


def rule_fires(conditions: list[dict], facts: dict[str, Any]) -> bool:
    """True when every condition holds for these facts (see FIELDS for the keys)."""
    return all(
        _compare(facts.get(c["field"]), FIELDS[c["field"]], c["op"], c["value"]) for c in conditions
    )


def describe_condition(condition: dict) -> str:
    """'Days until ship date less than 21', for reports and the playbook page."""
    field = FIELDS[condition["field"]]
    op = OPS[field.type][condition["op"]]
    value = condition["value"]
    if value is None:
        return f"{field.label} {op}"
    if field.type == "money":
        value = f"{value['currency']} {value['amountMinor'] / 100:,.2f}"
    return f"{field.label} {op} {value}"
