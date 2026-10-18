import base64
import binascii
import json
import logging
from datetime import UTC, date, datetime

from pydantic.alias_generators import to_camel
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.context import CompanyContext
from app.core.errors import AppError, not_found_error
from app.database.models import (
    Order,
    OrderStatus,
    OrderStatusChange,
    OrderStatusDefinition,
    StatusChangeSource,
    User,
)
from app.database.queries import audit as audit_queries
from app.database.queries import hs_codes as hs_queries
from app.database.queries import orders as order_queries
from app.schemas.analysis import OrderDetailOut, OrderUpdatedOut
from app.schemas.orders import (
    OrderOut,
    OrderStatusBulkChangeIn,
    OrderStatusBulkChangeOut,
    OrderStatusChangeIn,
    OrderStatusChangeOut,
    OrderStatusOut,
    OrderUpdate,
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


def _audit_value(value: object) -> object:
    return value.isoformat() if isinstance(value, date) else value


def update_order(
    db: Session, ctx: CompanyContext, external_id: str, payload: OrderUpdate
) -> OrderUpdatedOut:
    """Change an order's fields (not its id), then analyse it again: its latest report was
    made from the old facts. The change is audited field by field; nothing is saved or run
    when no field differs."""
    order = order_queries.get_order_by_external_id(db, ctx.company_id, external_id, lock=True)
    if not order:
        raise not_found_error("Order")
    changes = {}
    for name in sorted(payload.model_fields_set):
        before, after = getattr(order, name), getattr(payload, name)
        if before != after:
            changes[name] = (before, after)
            setattr(order, name, after)
    if not changes:
        db.rollback()  # releases the row lock
        return OrderUpdatedOut(detail=get_order_detail(db, ctx, external_id), run=None)
    if order.hs_code and "hs_code" in changes:
        # Suggestions waiting for a decision no longer apply once a person typed the code.
        hs_queries.reject_pending_hs_suggestions(db, order.id, ctx.user.id, datetime.now(UTC))
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action="order.updated",
        object_type="order",
        object_id=order.external_id,
        data={
            to_camel(name): {"from": _audit_value(a), "to": _audit_value(b)}
            for name, (a, b) in changes.items()
        },
    )
    db.commit()
    log.info(
        "order.updated",
        extra={
            "company_id": str(ctx.company_id),
            "order_id": str(order.id),
            "fields": sorted(changes),
        },
    )
    # Saved either way: if the run fails, it is recorded as failed and the order waits for
    # "Analyse orders", as after an import.
    try:
        run = analysis_service.start_run(db, ctx, [order.external_id])
    except AppError:
        run = None
    return OrderUpdatedOut(detail=get_order_detail(db, ctx, external_id), run=run)


def delete_order(db: Session, ctx: CompanyContext, external_id: str) -> None:
    """Remove an order with everything recorded about it (see order_queries.delete_order).
    The audit log keeps what the order was; saved solutions stay, without the report they were
    written from. The id is free again, so a CSV can bring the order back."""
    order = order_queries.get_order_by_external_id(db, ctx.company_id, external_id, lock=True)
    if not order:
        raise not_found_error("Order")
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action="order.deleted",
        object_type="order",
        object_id=order.external_id,
        data=OrderOut.from_order(order).model_dump(mode="json", by_alias=True, exclude={"id"}),
    )
    order_queries.delete_order(db, order)
    db.commit()
    log.info("order.deleted", extra={"company_id": str(ctx.company_id), "order_id": str(order.id)})


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


def _manual_status_definition(db: Session, status: OrderStatus) -> OrderStatusDefinition:
    definition = order_queries.get_order_status_definition(db, status)
    if definition is None or not definition.manual:
        raise AppError(
            422,
            "status_not_settable",
            "This status can't be set by hand.",
            {"status": "Choose one of the statuses from GET /order-statuses"},
        )
    return definition


def _manual_change(
    db: Session, ctx: CompanyContext, order: Order, status: OrderStatus, note: str
) -> OrderStatusChange:
    """Set the status and audit it; returns the history entry for the caller to add."""
    previous = order.status
    order.status = status
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action="order.status_changed",
        object_type="order",
        object_id=order.external_id,
        data={"from": previous.value, "to": status.value, "note": note},
    )
    return OrderStatusChange(
        company_id=ctx.company_id,
        order_id=order.id,
        from_status=previous,
        to_status=status,
        source=StatusChangeSource.manual,
        note=note,
        changed_by=ctx.user.id,
    )


def change_order_status(
    db: Session, ctx: CompanyContext, external_id: str, payload: OrderStatusChangeIn
) -> OrderDetailOut:
    """Set an order's status by hand, with a note saying why. The change goes on the order's
    history and in the audit log. The next analysis of the order sets its status again (and
    records that too)."""
    order = order_queries.get_order_by_external_id(db, ctx.company_id, external_id, lock=True)
    if not order:
        raise not_found_error("Order")
    definition = _manual_status_definition(db, payload.status)
    if order.status == payload.status:
        raise AppError(
            409,
            "status_unchanged",
            f"The order is already “{definition.label}”.",
            {"status": "Choose a different status"},
        )
    change = _manual_change(db, ctx, order, payload.status, payload.note)
    order_queries.add_status_changes(db, [change])
    db.commit()
    log.info(
        "order.status_changed",
        extra={
            "company_id": str(ctx.company_id),
            "order_id": str(order.id),
            "from_status": change.from_status.value,
            "to_status": payload.status.value,
        },
    )
    return get_order_detail(db, ctx, external_id)


def change_order_statuses(
    db: Session, ctx: CompanyContext, payload: OrderStatusBulkChangeIn
) -> OrderStatusBulkChangeOut:
    """Set several orders' status by hand with one note: all of them or none. Each order gets
    its own history entry and audit event, as if changed one at a time; orders that already
    have the status are left alone and listed as unchanged."""
    external_ids = list(dict.fromkeys(payload.order_ids))
    most = get_settings().max_status_change_orders
    if len(external_ids) > most:
        raise AppError(
            422,
            "too_many_orders",
            f"Change at most {most} orders at a time.",
            {"orderIds": f"Choose {most} orders or fewer"},
        )
    definition = _manual_status_definition(db, payload.status)
    found = {
        order.external_id: order
        for order in order_queries.lock_orders_by_external_ids(db, ctx.company_id, external_ids)
    }
    missing = [i for i in external_ids if i not in found]
    if missing:
        raise AppError(
            404,
            "not_found",
            "Some of these orders were not found.",
            {"orderIds": "Not found: " + ", ".join(missing)},
        )
    orders = [found[i] for i in external_ids]
    to_change = [o for o in orders if o.status != payload.status]
    unchanged = [o.external_id for o in orders if o.status == payload.status]
    if not to_change:
        raise AppError(
            409,
            "status_unchanged",
            f"These orders are already “{definition.label}”.",
            {"status": "Choose a different status"},
        )
    order_queries.add_status_changes(
        db, [_manual_change(db, ctx, o, payload.status, payload.note) for o in to_change]
    )
    db.commit()
    log.info(
        "order.statuses_changed",
        extra={
            "company_id": str(ctx.company_id),
            "changed": len(to_change),
            "unchanged": len(unchanged),
            "to_status": payload.status.value,
        },
    )
    return OrderStatusBulkChangeOut(
        changed=[OrderOut.from_order(o) for o in to_change], unchanged=unchanged
    )


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
        # sources move here. The dashboard shows the scan time from /api/impacts.
        sources_checked_at=None,
    )
