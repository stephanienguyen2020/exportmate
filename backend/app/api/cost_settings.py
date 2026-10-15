from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import OwnerContext, ViewerContext
from app.database.session import get_db
from app.schemas.common import SuccessResponse, success_response
from app.schemas.cost_settings import CostSettingOut, CostSettingsUpdate
from app.services import cost_settings as cost_service

router = APIRouter(prefix="/company/cost-settings", tags=["cost settings"])
Db = Annotated[Session, Depends(get_db)]


@router.get("", response_model=SuccessResponse[list[CostSettingOut]])
def list_cost_settings(ctx: ViewerContext, db: Db):
    """The cost assumptions analysis uses: the shared default or the company's own value."""
    return success_response(list(cost_service.get_cost_settings(db, ctx.company_id).values()))


@router.patch("", response_model=SuccessResponse[list[CostSettingOut]])
def update_cost_settings(payload: CostSettingsUpdate, ctx: OwnerContext, db: Db):
    """Set the company's own values; `value: null` goes back to the default."""
    return success_response(cost_service.update_cost_settings(db, ctx, payload))
