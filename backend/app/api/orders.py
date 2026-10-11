from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.auth import ViewerContext
from app.database.models import OrderStatus
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.orders import OrderDetailOut, OrderOut
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


@router.get("/orders/{order_id}", response_model=SuccessResponse[OrderDetailOut])
def get_order(order_id: str, ctx: ViewerContext, db: Db):
    return success_response(order_service.get_order_detail(db, ctx, order_id))


@router.get("/overview", response_model=SuccessResponse[OverviewOut])
def get_overview(ctx: ViewerContext, db: Db):
    return success_response(order_service.build_overview(db, ctx))
