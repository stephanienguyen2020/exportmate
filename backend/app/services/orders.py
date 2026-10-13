import base64
import binascii
import json
from datetime import UTC, date, datetime

from sqlalchemy.orm import Session

from app.core.context import CompanyContext
from app.core.errors import AppError, not_found_error
from app.database.models import Order, OrderStatus
from app.database.queries import orders as order_queries
from app.schemas.orders import OrderDetailOut, OrderOut, SourceRowOut
from app.schemas.overview import OverviewOut


def encode_order_cursor(order: Order) -> str:
    payload = json.dumps([order.ship_date.isoformat(), order.external_id])
    return base64.urlsafe_b64encode(payload.encode()).decode()


def decode_order_cursor(cursor: str) -> tuple[date, str]:
    try:
        ship_date, external_id = json.loads(base64.urlsafe_b64decode(cursor.encode()))
        return date.fromisoformat(ship_date), str(external_id)
    except (binascii.Error, ValueError, TypeError):
        raise AppError(422, "invalid_cursor", "Invalid cursor.", {"cursor": "Invalid cursor"})


def list_orders(
    db: Session,
    ctx: CompanyContext,
    *,
    status: OrderStatus | None,
    q: str | None,
    cursor: str | None,
    limit: int,
) -> tuple[list[Order], int, str | None]:
    after = decode_order_cursor(cursor) if cursor else None
    # Fetch one extra to know whether another page exists.
    orders, total = order_queries.list_orders_page(
        db, ctx.company_id, status=status, q=q, after=after, limit=limit + 1
    )
    next_cursor = encode_order_cursor(orders[limit - 1]) if len(orders) > limit else None
    return orders[:limit], total, next_cursor


def get_order_detail(db: Session, ctx: CompanyContext, external_id: str) -> OrderDetailOut:
    order = order_queries.get_order_by_external_id(db, ctx.company_id, external_id)
    if not order:
        raise not_found_error("Order")
    source = None
    if order.source_row_id:
        row = order_queries.get_import_row(db, order.source_row_id)
        source = SourceRowOut(
            import_id=row.import_id, row_number=row.row_number, raw=row.raw, row_hash=row.row_hash
        )
    return OrderDetailOut(order=OrderOut.from_order(order), source=source)


def build_overview(db: Session, ctx: CompanyContext) -> OverviewOut:
    counts = {s.value: 0 for s in OrderStatus}
    counts.update(order_queries.count_orders_by_status(db, ctx.company_id))
    today = datetime.now(UTC).date()
    return OverviewOut(
        total_orders=sum(counts.values()),
        counts_by_status=counts,
        value_at_risk_by_currency=order_queries.sum_order_value_by_currency(
            db, ctx.company_id, OrderStatus.exposed
        ),
        nearest_affected_ship_date=order_queries.find_nearest_ship_date(
            db, ctx.company_id, OrderStatus.exposed, today
        ),
        # News sources are read by the AI service; the backend learns of checks once rule
        # sources move here (REQUIREMENTS 4.5). The dashboard shows the scan time from /api/impacts.
        sources_checked_at=None,
    )
