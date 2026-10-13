import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, UploadFile
from sqlalchemy.orm import Session

from app.core.auth import EditorContext, ViewerContext
from app.core.config import get_settings
from app.core.rate_limit import RateLimiter
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.imports import CommitOut, ImportOut
from app.services import order_imports

router = APIRouter(tags=["imports"])
Db = Annotated[Session, Depends(get_db)]
upload_limiter = RateLimiter("uploads")


@router.post("/imports", response_model=SuccessResponse[ImportOut], status_code=201)
async def upload_import(file: UploadFile, ctx: EditorContext, db: Db):
    upload_limiter.check(str(ctx.user.id), get_settings().import_uploads_per_hour)
    # Read one byte past the limit so oversize files are rejected without loading them all.
    content = await file.read(get_settings().max_upload_bytes + 1)
    item = order_imports.upload_order_csv(db, ctx, file.filename or "upload.csv", content)
    return success_response(order_imports.build_import_response(db, item))


@router.get("/imports/{import_id}", response_model=SuccessResponse[ImportOut])
def get_import(import_id: uuid.UUID, ctx: ViewerContext, db: Db):
    item = order_imports.get_order_import(db, ctx, import_id)
    return success_response(order_imports.build_import_response(db, item))


@router.post("/imports/{import_id}/commit", response_model=SuccessResponse[CommitOut])
def commit_import(import_id: uuid.UUID, ctx: EditorContext, db: Db):
    return success_response(order_imports.commit_order_import(db, ctx, import_id))
