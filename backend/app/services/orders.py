import base64
import binascii
import json
import logging
from datetime import UTC, date, datetime

from sqlalchemy.orm import Session

from app.core.context import CompanyContext
from app.core.errors import AppError, not_found_error
from app.database.models import (
    Order,
    OrderStatus,
    OrderStatusChange,
    StatusChangeSource,
    User,
)
from app.database.queries import audit as audit_queries
from app.database.queries import orders as order_queries
from app.schemas.analysis import OrderDetailOut
from app.schemas.orders import (
    OrderOut,
    OrderStatusChangeIn,
    OrderStatusChangeOut,
    OrderStatusOut,
    SourceRowOut,
    StatusChangerOut,
)
from app.schemas.overview import OverviewOut
from app.services import analysis as analysis_service

log = logging.getLogger(__name__)


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
    latest_report_id, exposures = analysis_service.latest_exposures(db, order)
    return OrderDetailOut(
        order=OrderOut.from_order(order),
        source=source,
        exposures=exposures,
        latest_report_id=latest_report_id,
        status_changes=[
            _status_change_out(change, user)
            for change, user in order_queries.list_order_status_changes(db, order.id)
        ],
    )


def _status_change_out(change: OrderStatusChange, user: User) -> OrderStatusChangeOut:
    return OrderStatusChangeOut(
        id=change.id,
        from_status=change.from_status,
        to_status=change.to_status,
        source=change.source.value,
        note=change.note,
        run_id=change.run_id,
        changed_by=StatusChangerOut(id=user.id, name=user.name or user.email),
        changed_at=change.changed_at,
    )


def list_order_statuses(db: Session) -> list[OrderStatusOut]:
    return [OrderStatusOut.from_definition(d) for d in order_queries.list_order_statuses(db)]


def change_order_status(
    db: Session, ctx: CompanyContext, external_id: str, payload: OrderStatusChangeIn
) -> OrderDetailOut:
    """Set an order's status by hand, with a note saying why. The change goes on the order's
    history and in the audit log. The next analysis of the order sets its status again (and
    records that too)."""
    order = order_queries.get_order_by_external_id(db, ctx.company_id, external_id, lock=True)
    if not order:
        raise not_found_error("Order")
    definition = order_queries.get_order_status_definition(db, payload.status)
    if definition is None or not definition.manual:
        raise AppError(
            422,
            "status_not_settable",
            "This status can't be set by hand.",
            {"status": "Choose one of the statuses from GET /order-statuses"},
        )
    if order.status == payload.status:
        raise AppError(
            409,
            "status_unchanged",
            f"The order is already “{definition.label}”.",
            {"status": "Choose a different status"},
        )
    previous = order.status
    order.status = payload.status
    order_queries.add_status_changes(
        db,
        [
            OrderStatusChange(
                company_id=ctx.company_id,
                order_id=order.id,
                from_status=previous,
                to_status=payload.status,
                source=StatusChangeSource.manual,
                note=payload.note,
                changed_by=ctx.user.id,
            )
        ],
    )
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action="order.status_changed",
        object_type="order",
        object_id=order.external_id,
        data={"from": previous.value, "to": payload.status.value, "note": payload.note},
    )
    db.commit()
    log.info(
        "order.status_changed",
        extra={
            "company_id": str(ctx.company_id),
            "order_id": str(order.id),
            "from_status": previous.value,
            "to_status": payload.status.value,
        },
    )
    return get_order_detail(db, ctx, external_id)


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
        # sources move here (docs/REQUIREMENTS.md 4.5). The dashboard shows the scan time from /api/impacts.
        sources_checked_at=None,
    )
