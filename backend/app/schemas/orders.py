import uuid
from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import StringConstraints

from app.database.models import Order, OrderStatus, OrderStatusDefinition
from app.schemas.common import CamelCaseModel


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

    @classmethod
    def from_definition(cls, definition: OrderStatusDefinition) -> "OrderStatusOut":
        return cls(
            code=definition.code,
            label=definition.label,
            description=definition.description,
            tone=definition.tone,
            manual=definition.manual,
        )


class OrderStatusChangeIn(CamelCaseModel):
    status: OrderStatus
    # Why the status is changed by hand; kept on the order's history and in the audit log.
    note: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)]


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
