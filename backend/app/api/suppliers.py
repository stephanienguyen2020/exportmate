import uuid
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import EditorContext
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.trade_map import SupplierIn, SupplierOut, SupplierUpdate
from app.services import suppliers as supplier_service

router = APIRouter(prefix="/suppliers", tags=["trade map"])
Db = Annotated[Session, Depends(get_db)]


@router.post("", response_model=SuccessResponse[SupplierOut], status_code=201)
def create_supplier(payload: SupplierIn, ctx: EditorContext, db: Db):
    """Add a supplier, optionally with a location and the documents it has on file."""
    return success_response(supplier_service.create_supplier(db, ctx, payload))


@router.patch("/{supplier_id}", response_model=SuccessResponse[SupplierOut])
def update_supplier(supplier_id: uuid.UUID, payload: SupplierUpdate, ctx: EditorContext, db: Db):
    return success_response(supplier_service.update_supplier(db, ctx, supplier_id, payload))


@router.delete("/{supplier_id}", response_model=SuccessResponse[dict])
def delete_supplier(supplier_id: uuid.UUID, ctx: EditorContext, db: Db):
    supplier_service.delete_supplier(db, ctx, supplier_id)
    return success_response({"deleted": True})
