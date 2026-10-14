import uuid
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import EditorContext
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.trade_map import SiteIn, SiteOut, SiteUpdate
from app.services import company_sites as site_service

router = APIRouter(prefix="/sites", tags=["trade map"])
Db = Annotated[Session, Depends(get_db)]


@router.post("", response_model=SuccessResponse[SiteOut], status_code=201)
def create_site(payload: SiteIn, ctx: EditorContext, db: Db):
    """Add a factory, port or warehouse of the company's own."""
    return success_response(site_service.create_site(db, ctx, payload))


@router.patch("/{site_id}", response_model=SuccessResponse[SiteOut])
def update_site(site_id: uuid.UUID, payload: SiteUpdate, ctx: EditorContext, db: Db):
    return success_response(site_service.update_site(db, ctx, site_id, payload))


@router.delete("/{site_id}", response_model=SuccessResponse[dict])
def delete_site(site_id: uuid.UUID, ctx: EditorContext, db: Db):
    site_service.delete_site(db, ctx, site_id)
    return success_response({"deleted": True})
