from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.auth import ViewerContext
from app.core.errors import AppError
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.trade_map import MarketComparisonOut, TradeMapOut
from app.services import trade_map as trade_map_service

router = APIRouter(prefix="/trade-map", tags=["trade map"])
Db = Annotated[Session, Depends(get_db)]


@router.get("", response_model=SuccessResponse[TradeMapOut])
def get_trade_map(ctx: ViewerContext, db: Db):
    """Markets, the company's orders placed on the map with their document checks, its
    suppliers and sites, and satellite observations with the places near them."""
    return success_response(trade_map_service.build_trade_map(db, ctx))


@router.get("/compare", response_model=SuccessResponse[MarketComparisonOut])
def compare_order(
    ctx: ViewerContext,
    db: Db,
    order_id: Annotated[str, Query(alias="orderId", min_length=1, max_length=100)],
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
