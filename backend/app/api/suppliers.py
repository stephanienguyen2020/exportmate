import uuid
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import EditorContext, ViewerContext
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.trade_map import (
    MapSupplierOut,
    SupplierDeletedOut,
    SupplierIn,
    SupplierOut,
    SupplierUpdate,
)
from app.services import suppliers as supplier_service
from app.services import trade_map as trade_map_service

router = APIRouter(prefix="/suppliers", tags=["trade map"])
Db = Annotated[Session, Depends(get_db)]


@router.get("", response_model=SuccessResponse[list[MapSupplierOut]])
def list_suppliers(ctx: ViewerContext, db: Db):
    """The company's suppliers with their documents, sourcing and the orders that name them,
    then supplier names its orders use that have no record yet (`id` null)."""
    return success_response(trade_map_service.list_suppliers(db, ctx))


@router.post("", response_model=SuccessResponse[SupplierOut], status_code=201)
def create_supplier(payload: SupplierIn, ctx: EditorContext, db: Db):
    """Add a supplier, optionally with a location and the documents it has on file. The orders
    that name it are analysed again (`analysedOrderIds`)."""
    return success_response(supplier_service.create_supplier(db, ctx, payload))


@router.patch("/{supplier_id}", response_model=SuccessResponse[SupplierOut])
def update_supplier(supplier_id: uuid.UUID, payload: SupplierUpdate, ctx: EditorContext, db: Db):
    """Change the fields sent. A new name or documents analyses the orders that name it again."""
    return success_response(supplier_service.update_supplier(db, ctx, supplier_id, payload))


@router.delete("/{supplier_id}", response_model=SuccessResponse[SupplierDeletedOut])
def delete_supplier(supplier_id: uuid.UUID, ctx: EditorContext, db: Db):
    return success_response(supplier_service.delete_supplier(db, ctx, supplier_id))
