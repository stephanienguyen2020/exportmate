from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.auth import EditorContext, ViewerContext
from app.database.models import OrderStatus
from app.database.session import get_db
from app.schemas.analysis import OrderDetailOut, OrderUpdatedOut
from app.schemas.common import SuccessResponse, success_response
from app.schemas.orders import (
    OrderOut,
    OrderStatusBulkChangeIn,
    OrderStatusBulkChangeOut,
    OrderStatusChangeIn,
    OrderStatusOut,
    OrderUpdate,
)
from app.schemas.overview import OverviewOut
from app.services import orders as order_service

router = APIRouter(tags=["orders"])
Db = Annotated[Session, Depends(get_db)]


@router.get("/orders", response_model=SuccessResponse[list[OrderOut]])
def list_orders(
    ctx: ViewerContext,
    db: Db,
    status: OrderStatus | None = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
):
    orders, total, next_cursor = order_service.list_orders(
        db, ctx, status=status, q=q, cursor=cursor, limit=limit
    )
    return success_response(
        [OrderOut.from_order(o) for o in orders], total=total, nextCursor=next_cursor
    )


@router.patch("/orders/status", response_model=SuccessResponse[OrderStatusBulkChangeOut])
def change_order_statuses(payload: OrderStatusBulkChangeIn, ctx: EditorContext, db: Db):
    """Set several orders' status by hand with one note (owners and editors): all of them or
    none. Each change is on its order's `statusChanges` and audited as `order.status_changed`;
    orders that already have the status are returned as `unchanged`."""
    return success_response(order_service.change_order_statuses(db, ctx, payload))


@router.get("/orders/{order_id}", response_model=SuccessResponse[OrderDetailOut])
def get_order(order_id: str, ctx: ViewerContext, db: Db):
    return success_response(order_service.get_order_detail(db, ctx, order_id))


@router.patch("/orders/{order_id}", response_model=SuccessResponse[OrderUpdatedOut])
def update_order(order_id: str, payload: OrderUpdate, ctx: EditorContext, db: Db):
    """Change an order's fields, not its id (owners and editors). Audited as `order.updated`;
    the order is then analysed again, as `POST /runs` with its id would."""
    return success_response(order_service.update_order(db, ctx, order_id, payload))


@router.delete("/orders/{order_id}", response_model=SuccessResponse[dict])
def delete_order(order_id: str, ctx: EditorContext, db: Db):
    """Remove an order with its status history, analysis reports, supplier messages, HS code
    suggestions, saved what-ifs and news reviews (owners and editors). Audited as
    `order.deleted` with what the order was."""
    order_service.delete_order(db, ctx, order_id)
    return success_response({"deleted": True})


@router.patch("/orders/{order_id}/status", response_model=SuccessResponse[OrderDetailOut])
def change_order_status(order_id: str, payload: OrderStatusChangeIn, ctx: EditorContext, db: Db):
    """Set an order's status by hand, with a note saying why (owners and editors). Recorded in
    the order's `statusChanges` and audited as `order.status_changed`."""
    return success_response(order_service.change_order_status(db, ctx, order_id, payload))


@router.get("/order-statuses", response_model=SuccessResponse[list[OrderStatusOut]])
def list_order_statuses(ctx: ViewerContext, db: Db):
    """Every order status with its label, description and colour, from the database; `manual`
    marks those a person may set by hand."""
    return success_response(order_service.list_order_statuses(db))


@router.get("/overview", response_model=SuccessResponse[OverviewOut])
def get_overview(ctx: ViewerContext, db: Db):
    return success_response(order_service.build_overview(db, ctx))
