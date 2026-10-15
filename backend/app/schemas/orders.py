import uuid
from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import Field, StringConstraints, field_validator, model_validator

from app.core.currencies import is_currency
from app.database.models import Order, OrderStatus, OrderStatusDefinition
from app.schemas.common import CamelCaseModel
from app.services.order_csv import HS_CODE_PATTERN, MAX_LENGTHS, MAX_VALUE


class OrderOut(CamelCaseModel):
    id: str  # the company's own order id, e.g. "PO-2291"
    product: str
    supplier: str
    destination: str
    value_minor: int  # hundredths of the currency unit for every currency: 2400000 = 24,000.00
    currency: str
    ship_date: date
    hs_code: str
    status: OrderStatus

    @classmethod
    def from_order(cls, order: Order) -> "OrderOut":
        return cls(
            id=order.external_id,
            product=order.product,
            supplier=order.supplier,
            destination=order.destination,
            value_minor=order.value_minor,
            currency=order.currency,
            ship_date=order.ship_date,
            hs_code=order.hs_code,
            status=order.status,
        )


def _order_text(column: str):
    """A required text field of an order, as long as a CSV cell of that column may be."""
    return Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_LENGTHS[column])
    ]


OrderProduct = _order_text("product")
OrderSupplier = _order_text("supplier")
OrderDestination = _order_text("destination")


class OrderUpdate(CamelCaseModel):
    """Changes only the fields sent, with the same rules as a CSV row (services/order_csv.py).
    The order's id can't change: reports, solutions and the audit log name the order by it."""

    product: OrderProduct | None = None
    supplier: OrderSupplier | None = None
    destination: OrderDestination | None = None
    # Hundredths of the currency unit, as OrderOut gives it.
    value_minor: int | None = Field(default=None, gt=0, lt=int(MAX_VALUE * 100))
    currency: str | None = None
    ship_date: date | None = None
    hs_code: str | None = None  # "" clears it: analysis then asks for the code

    @field_validator("currency")
    @classmethod
    def _known_currency(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip().upper()
        if not is_currency(value):
            raise ValueError("Use an ISO currency code like USD.")
        return value

    @field_validator("hs_code")
    @classmethod
    def _hs_code_shape(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if value and not HS_CODE_PATTERN.match(value):
            raise ValueError("Use an HS code like 1234.56 (digits, optional dots).")
        return value

    @model_validator(mode="after")
    def _sent_fields_stay_set(self):
        for name in self.model_fields_set:
            if getattr(self, name) is None:
                raise ValueError(f"{name} can't be cleared")
        return self


class SourceRowOut(CamelCaseModel):
    import_id: uuid.UUID
    row_number: int
    raw: dict[str, str]
    row_hash: str


class OrderStatusOut(CamelCaseModel):
    """One order status as the database names it (seed_data/reference.json)."""

    code: OrderStatus
    label: str
    description: str
    tone: str  # green, amber or red
    manual: bool  # an owner or editor may set it by hand
    retired: bool  # no longer given to orders; only earlier status changes name it

    @classmethod
    def from_definition(cls, definition: OrderStatusDefinition) -> "OrderStatusOut":
        return cls(
            code=definition.code,
            label=definition.label,
            description=definition.description,
            tone=definition.tone,
            manual=definition.manual,
            retired=definition.retired,
        )


class OrderStatusChangeIn(CamelCaseModel):
    status: OrderStatus
    # Why the status is changed by hand; kept on the order's history and in the audit log.
    note: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]


class OrderStatusBulkChangeIn(CamelCaseModel):
    # The company's own order ids, e.g. "PO-2291"; the most allowed is a setting.
    order_ids: list[Annotated[str, StringConstraints(min_length=1, max_length=100)]] = Field(
        min_length=1
    )
    status: OrderStatus
    note: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]


class OrderStatusBulkChangeOut(CamelCaseModel):
    changed: list[OrderOut]  # in the order they were asked for
    unchanged: list[str]  # ids of orders that already had the status


class StatusChangerOut(CamelCaseModel):
    id: uuid.UUID
    name: str


class OrderStatusChangeOut(CamelCaseModel):
    id: uuid.UUID
    from_status: OrderStatus
    to_status: OrderStatus
    source: Literal["manual", "analysis"]
    note: str | None  # always set for a manual change
    run_id: uuid.UUID | None  # the analysis run that set it
    changed_by: StatusChangerOut
    changed_at: datetime
