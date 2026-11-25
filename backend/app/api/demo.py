from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.api.account import _account_response
from app.api.audit_log import _visitor_ip
from app.core.auth import CurrentClaims, CurrentUser
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.rate_limit import RateLimiter
from app.database.session import get_db
from app.schemas.account import AccountOut
from app.schemas.common import SuccessResponse, success_response
from app.services import demo

router = APIRouter(tags=["demo"])
Db = Annotated[Session, Depends(get_db)]
sandbox_limiter = RateLimiter("demo sandboxes")


@router.post("/demo", response_model=SuccessResponse[AccountOut], status_code=201)
def open_demo(request: Request, claims: CurrentClaims, user: CurrentUser, db: Db):
    """The demo visitor's own sandbox copy of the demo company (services/demo.py), opened on
    first call; later calls return the same one until it expires."""
    if not claims.anonymous:
        raise AppError(409, "not_demo_visitor", "Sign out to open the demo.")
    if demo.current_sandbox(db, user) is None:
        sandbox_limiter.check(_visitor_ip(request), get_settings().demo_sandboxes_per_hour)
    company, role = demo.open_sandbox(db, user)
    return success_response(_account_response(user, company, role))
