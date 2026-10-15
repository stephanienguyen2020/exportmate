import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Header
from sqlalchemy.orm import Session

from app.core.auth import EditorContext, OwnerContext, ViewerContext
from app.core.config import get_settings
from app.core.rate_limit import RateLimiter
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.supplier_messages import (
    SupplierMessageDraftIn,
    SupplierMessageOut,
    SupplierMessageUpdate,
)
from app.services import supplier_messages as message_service

router = APIRouter(tags=["supplier messages"])
Db = Annotated[Session, Depends(get_db)]
draft_limiter = RateLimiter("message drafts")


@router.post(
    "/supplier-messages", response_model=SuccessResponse[SupplierMessageOut], status_code=201
)
def draft_supplier_message(payload: SupplierMessageDraftIn, ctx: EditorContext, db: Db):
    """AI drafts an email to the order's supplier from an analysis report, asking for the
    missing documents. The recipient defaults to the supplier's contact email."""
    draft_limiter.check(str(ctx.user.id), get_settings().supplier_message_drafts_per_hour)
    return success_response(message_service.draft_supplier_message(db, ctx, payload))


@router.get(
    "/orders/{order_id}/supplier-messages",
    response_model=SuccessResponse[list[SupplierMessageOut]],
)
def list_order_supplier_messages(order_id: str, ctx: ViewerContext, db: Db):
    return success_response(message_service.list_order_supplier_messages(db, ctx, order_id))


@router.get("/supplier-messages/{message_id}", response_model=SuccessResponse[SupplierMessageOut])
def get_supplier_message(message_id: uuid.UUID, ctx: ViewerContext, db: Db):
    """The message and its state: draft → approved → sent, or failed."""
    return success_response(message_service.get_supplier_message(db, ctx, message_id))


@router.patch("/supplier-messages/{message_id}", response_model=SuccessResponse[SupplierMessageOut])
def update_supplier_message(
    message_id: uuid.UUID, payload: SupplierMessageUpdate, ctx: EditorContext, db: Db
):
    """Edit the recipient, subject or body. An approved message goes back to draft."""
    return success_response(message_service.update_supplier_message(db, ctx, message_id, payload))


@router.post(
    "/supplier-messages/{message_id}/approve",
    response_model=SuccessResponse[SupplierMessageOut],
)
def approve_supplier_message(message_id: uuid.UUID, ctx: OwnerContext, db: Db):
    """Approve the exact recipient, subject and body."""
    return success_response(message_service.approve_supplier_message(db, ctx, message_id))


@router.post(
    "/supplier-messages/{message_id}/send", response_model=SuccessResponse[SupplierMessageOut]
)
def send_supplier_message(
    message_id: uuid.UUID,
    ctx: OwnerContext,
    db: Db,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key", max_length=100)] = None,
):
    """Send the approved message once (sandbox without RESEND_API_KEY)."""
    return success_response(
        message_service.send_supplier_message(db, ctx, message_id, idempotency_key)
    )
