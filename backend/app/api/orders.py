from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.auth import EditorContext, ViewerContext
from app.core.errors import AppError
from app.database.models import OrderStatus
from app.database.session import get_db
from app.schemas.analysis import OrderDetailOut, OrderUpdatedOut
from app.schemas.common import SuccessResponse, success_response
from app.schemas.orders import (
    OrderStatusBulkChangeIn,
    OrderStatusBulkChangeOut,
    OrderStatusChangeIn,
    OrderStatusOut,
    OrderUpdate,
)
from app.schemas.overview import OverviewOut
from app.schemas.trade_map import ChecklistDetail, MarketComparisonOut, OrderListItemOut
from app.services import orders as order_service
from app.services import trade_map as trade_map_service

router = APIRouter(tags=["orders"])
Db = Annotated[Session, Depends(get_db)]


@router.get("/orders", response_model=SuccessResponse[list[OrderListItemOut]])
def list_orders(
    ctx: ViewerContext,
    db: Db,
    status: OrderStatus | None = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    order_ids: Annotated[list[str] | None, Query(alias="id", max_length=50)] = None,
    market: Annotated[str | None, Query(min_length=2, max_length=8)] = None,
    checklist: ChecklistDetail = "none",
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
):
    """The company's orders by ship date, filtered by status, text (`q`: ID, product,
    supplier, destination or HS code), order IDs (`id`, repeated) and destination market. Each
    has its placement and gap count; `checklist=gaps` or `all` adds its document checks."""
    orders, total, next_cursor = order_service.list_orders(
        db,
        ctx,
        status=status,
        q=q,
        ids=order_ids,
        market=market,
        checklist=checklist,
        cursor=cursor,
        limit=limit,
    )
    return success_response(orders, total=total, nextCursor=next_cursor)


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


@router.get("/orders/{order_id}/what-if", response_model=SuccessResponse[MarketComparisonOut])
def compare_order(
    order_id: str,
    ctx: ViewerContext,
    db: Db,
    market: Annotated[str | None, Query(min_length=2, max_length=8)] = None,
    ship_date: Annotated[date | None, Query(alias="shipDate")] = None,
    via: Annotated[str | None, Query(min_length=2, max_length=12)] = None,
):
    """One what-if at a time: another market, another ship date, or another route.

    Market comparison is paperwork only. A ship date uses checklist effective and change
    dates. A route names what to recheck and a great-circle distance; it does not price freight.
    """
    chosen = [value is not None for value in (market, ship_date, via)]
    if sum(chosen) != 1:
        raise AppError(
            422,
            "invalid_input",
            "Compare one change at a time: a market, a ship date, or a route.",
            {"compare": "Pick one change"},
        )
    if market is not None:
        result = trade_map_service.compare_order_markets(db, ctx, order_id, market)
    elif ship_date is not None:
        result = trade_map_service.compare_ship_date(db, ctx, order_id, ship_date)
    else:
        assert via is not None
        result = trade_map_service.compare_route(db, ctx, order_id, via)
    return success_response(result)
