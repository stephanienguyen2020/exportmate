import uuid
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, Form, Query, Response, UploadFile
from sqlalchemy.orm import Session

from app.core.auth import EditorContext, ViewerContext
from app.core.config import get_settings
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.regulations import DocumentOut, RegulationDetailOut, RegulationOut
from app.services import regulations as regulation_service

router = APIRouter(tags=["regulations"])
Db = Annotated[Session, Depends(get_db)]


@router.post("/documents", response_model=SuccessResponse[DocumentOut], status_code=201)
async def upload_document(
    file: UploadFile,
    ctx: EditorContext,
    db: Db,
    title: Annotated[str, Form()],
    source_url: Annotated[str | None, Form(alias="sourceUrl")] = None,
    regulation_id: Annotated[uuid.UUID | None, Form(alias="regulationId")] = None,
    official_id: Annotated[str | None, Form(alias="officialId")] = None,
):
    """Upload a rule text or article: a new regulation, or its next version via `regulationId`."""
    # Read one byte past the limit so oversize files are rejected without loading them all.
    content = await file.read(get_settings().max_upload_bytes + 1)
    document = regulation_service.upload_source_document(
        db,
        ctx,
        filename=file.filename or "upload",
        content=content,
        title=title,
        source_url=source_url,
        regulation_id=regulation_id,
        official_id=official_id,
    )
    return success_response(DocumentOut.model_validate(document))


@router.get("/documents/{document_id}", response_model=SuccessResponse[DocumentOut])
def get_document(document_id: uuid.UUID, ctx: ViewerContext, db: Db):
    document = regulation_service.get_source_document(db, ctx, document_id)
    return success_response(DocumentOut.model_validate(document))


@router.get("/documents/{document_id}/file", response_class=Response)
def download_document_file(document_id: uuid.UUID, ctx: ViewerContext, db: Db):
    document, content = regulation_service.load_source_document_file(db, ctx, document_id)
    return Response(
        content,
        media_type=document.content_type,
        headers={
            # Always a download, never rendered on our domain (uploaded HTML could hold scripts).
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(document.filename)}",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/regulations", response_model=SuccessResponse[list[RegulationOut]])
def list_regulations(
    ctx: ViewerContext,
    db: Db,
    official_id: Annotated[str | None, Query(alias="officialId")] = None,
):
    """All regulations, or the one with `officialId` (to pre-select it in the upload form)."""
    return success_response(regulation_service.list_regulations(db, ctx, official_id))


@router.get("/regulations/{regulation_id}", response_model=SuccessResponse[RegulationDetailOut])
def get_regulation(regulation_id: uuid.UUID, ctx: ViewerContext, db: Db):
    return success_response(regulation_service.get_regulation_detail(db, ctx, regulation_id))
