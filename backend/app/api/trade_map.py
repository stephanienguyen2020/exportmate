from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import ViewerContext
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.trade_map import TradeMapOut
from app.services import trade_map as trade_map_service

router = APIRouter(prefix="/trade-map", tags=["trade map"])
Db = Annotated[Session, Depends(get_db)]


@router.get("", response_model=SuccessResponse[TradeMapOut])
def get_trade_map(ctx: ViewerContext, db: Db):
    """What the map draws besides the company's orders (GET /orders), suppliers (GET
    /suppliers) and sites (GET /sites): markets, satellite observations with the company's
    places near them, and the countries, document kinds and materials its forms offer."""
    return success_response(trade_map_service.build_trade_map(db, ctx))
