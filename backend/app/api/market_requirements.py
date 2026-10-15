import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.auth import EditorContext, OwnerContext, ViewerContext
from app.core.config import get_settings
from app.core.rate_limit import RateLimiter
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.market_requirements import (
    DraftedRequirementsOut,
    MarketRequirementOut,
    MarketRequirementUpdate,
    VersionRequirementsOut,
)
from app.services import market_requirements as requirement_service

router = APIRouter(tags=["market requirements"])
Db = Annotated[Session, Depends(get_db)]
draft_limiter = RateLimiter("requirement drafts")


@router.post(
    "/regulation-documents/{document_id}/requirements",
    response_model=SuccessResponse[DraftedRequirementsOut],
    status_code=201,
)
def draft_requirements(document_id: uuid.UUID, ctx: EditorContext, db: Db):
    """AI drafts the market requirements one version of the company's own regulation sets,
    each with its quote. Replaces earlier drafts of that version; the owner reviews them."""
    draft_limiter.check(str(ctx.user.id), get_settings().requirement_drafts_per_hour)
    return success_response(requirement_service.draft_requirements(db, ctx, document_id))


@router.get(
    "/regulations/{regulation_id}/requirements",
    response_model=SuccessResponse[VersionRequirementsOut],
)
def get_version_requirements(
    regulation_id: uuid.UUID,
    ctx: ViewerContext,
    db: Db,
    version: Annotated[int | None, Query(ge=1)] = None,
):
    """The market requirements a version sets (default: the latest) and what changed from the
    previous version."""
    return success_response(
        requirement_service.get_version_requirements(db, ctx, regulation_id, version)
    )


@router.patch(
    "/market-requirements/{requirement_id}",
    response_model=SuccessResponse[MarketRequirementOut],
)
def review_market_requirement(
    requirement_id: uuid.UUID, payload: MarketRequirementUpdate, ctx: OwnerContext, db: Db
):
    """Edit a drafted requirement and/or decide it: `status` `reviewed` or `rejected`."""
    return success_response(
        requirement_service.review_market_requirement(db, ctx, requirement_id, payload)
    )
