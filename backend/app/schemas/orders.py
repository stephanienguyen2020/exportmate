import uuid
from datetime import date

from pydantic import Field

from app.database.models import Order, OrderStatus
from app.schemas.common import CamelCaseModel


class OrderOut(CamelCaseModel):
    id: str  # the company's own order id, e.g. "PO-2291"
    product: str
    supplier: str
    destination: str
    value_minor: int  # cents: 2400000 = 24,000.00
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


class OrderDetailOut(CamelCaseModel):
    order: OrderOut
    source: SourceRowOut | None  # None for seeded orders
    exposures: list = Field(default_factory=list)  # filled in phase 2
