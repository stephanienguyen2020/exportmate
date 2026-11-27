from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.auth import ViewerContext
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.trade_risk import TradeRiskOut
from app.services import trade_risk as trade_risk_service

router = APIRouter(prefix="/trade-risk", tags=["trade risk"])
Db = Annotated[Session, Depends(get_db)]


@router.get("", response_model=SuccessResponse[TradeRiskOut])
def get_market_trade_risk(
    ctx: ViewerContext,
    db: Db,
    destination: Annotated[str, Query(min_length=2, max_length=200)],
    hs_code: Annotated[str, Query(alias="hsCode", min_length=6, max_length=20)],
    exporter: Annotated[str | None, Query(min_length=2, max_length=2)] = None,
):
    """The risk of an anti-dumping or anti-subsidy case on a product into a destination (a
    country code, or "Rotterdam, NL"), from the company's country unless `exporter` is given:
    for trade map what-ifs and the assistant."""
    return success_response(trade_risk_service.market_risk(db, ctx, destination, hs_code, exporter))


@router.get("/orders/{order_id}", response_model=SuccessResponse[TradeRiskOut])
def get_order_trade_risk(order_id: str, ctx: ViewerContext, db: Db):
    """The risk for an order's destination, the company's country and the order's HS code.
    `pending` means it is being scored; ask again in about 10 seconds."""
    return success_response(trade_risk_service.order_risk(db, ctx, order_id))
