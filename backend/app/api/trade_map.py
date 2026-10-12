from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.auth import ViewerContext
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
def compare_markets(
    ctx: ViewerContext,
    db: Db,
    order_id: Annotated[str, Query(alias="orderId", min_length=1, max_length=100)],
    market: Annotated[str, Query(min_length=2, max_length=8)],
):
    """What carries over, what to re-evaluate and what can't be concluded if `orderId`
    shipped to `market` instead. Paperwork only; not the customer, contract or sales case."""
    return success_response(trade_map_service.compare_order_markets(db, ctx, order_id, market))
