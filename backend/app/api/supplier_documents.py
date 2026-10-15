import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, UploadFile
from sqlalchemy.orm import Session

from app.core.auth import EditorContext
from app.core.config import get_settings
from app.core.rate_limit import RateLimiter
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.supplier_documents import (
    ConfirmedSupplierDocumentOut,
    SupplierDocumentConfirmIn,
    SupplierDocumentUploadOut,
)
from app.services import supplier_documents as document_service

router = APIRouter(tags=["supplier documents"])
Db = Annotated[Session, Depends(get_db)]
upload_limiter = RateLimiter("supplier document uploads")


@router.post(
    "/suppliers/{supplier_id}/documents",
    response_model=SuccessResponse[SupplierDocumentUploadOut],
    status_code=201,
)
async def upload_supplier_document(
    supplier_id: uuid.UUID, file: UploadFile, ctx: EditorContext, db: Db
):
    """Upload a certificate (PDF, PNG or JPEG, up to 4 MB). AI reads its fields as a draft;
    nothing is checked against orders until a person confirms them."""
    upload_limiter.check(str(ctx.user.id), get_settings().supplier_document_uploads_per_hour)
    content = await file.read(get_settings().max_upload_bytes + 1)
    return success_response(
        document_service.upload_supplier_document(
            db, ctx, supplier_id, file.filename or "upload", content
        )
    )


@router.post(
    "/supplier-documents/{upload_id}/confirm",
    response_model=SuccessResponse[ConfirmedSupplierDocumentOut],
)
def confirm_supplier_document(
    upload_id: uuid.UUID, payload: SupplierDocumentConfirmIn, ctx: EditorContext, db: Db
):
    """Save the fields as the person checked them. The document replaces the supplier's
    previous one of the same kind and counts in the trade map and analysis from now on."""
    return success_response(document_service.confirm_supplier_document(db, ctx, upload_id, payload))
