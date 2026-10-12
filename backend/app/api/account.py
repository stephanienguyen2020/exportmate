from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import CurrentClaims, CurrentUser, OwnerContext, ViewerContext, revoke_sessions
from app.database.models import Company, Role, User
from app.database.session import get_db
from app.schemas.account import (
    AccountOut,
    CompanyKnowledgeOut,
    CompanyOut,
    CompanyUpdate,
    OnboardingIn,
    UserOut,
    UserUpdate,
)
from app.schemas.common import SuccessResponse, success_response
from app.services import accounts

router = APIRouter(tags=["account"])
Db = Annotated[Session, Depends(get_db)]


def _account_response(user: User, company: Company | None, role: Role | None) -> AccountOut:
    return AccountOut(
        user=UserOut.model_validate(user),
        company=CompanyOut.model_validate(company) if company else None,
        role=role,
        onboarded=company is not None,
    )


@router.get("/me", response_model=SuccessResponse[AccountOut])
def get_account(user: CurrentUser, db: Db):
    found = accounts.find_user_company_membership(db, user.id)
    membership, company = found if found else (None, None)
    return success_response(
        _account_response(user, company, membership.role if membership else None)
    )


@router.patch("/me", response_model=SuccessResponse[AccountOut])
def update_account(payload: UserUpdate, user: CurrentUser, db: Db):
    accounts.update_user_profile(db, user, payload)
    return get_account(user, db)


@router.post("/me/logout", response_model=SuccessResponse[dict])
def logout_everywhere(claims: CurrentClaims):
    revoke_sessions(claims.uid)
    return success_response({"signedOut": True})


@router.post("/onboarding", response_model=SuccessResponse[AccountOut], status_code=201)
def complete_onboarding(payload: OnboardingIn, user: CurrentUser, db: Db):
    company, role = accounts.onboard_user(db, user, payload)
    return success_response(_account_response(user, company, role))


@router.patch("/company", response_model=SuccessResponse[CompanyOut])
def update_company(payload: CompanyUpdate, ctx: OwnerContext, db: Db):
    company = accounts.update_company_profile(db, ctx, payload)
    return success_response(CompanyOut.model_validate(company))


@router.get("/company/knowledge", response_model=SuccessResponse[CompanyKnowledgeOut])
def get_company_knowledge(ctx: ViewerContext, db: Db):
    """The caller's company profile and sites. The AI service fetches this with the user's own
    token to answer questions about the company; it never reads the database directly."""
    return success_response(accounts.build_company_knowledge(db, ctx))
