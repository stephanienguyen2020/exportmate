import uuid
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import CurrentUser, OwnerContext, ViewerContext
from app.core.config import get_settings
from app.core.rate_limit import RateLimiter
from app.database.session import get_db
from app.schemas.account import AccountOut, CompanyOut, UserOut
from app.schemas.common import SuccessResponse, success_response
from app.schemas.members import (
    InviteIn,
    InviteOut,
    InviteSentOut,
    MemberOut,
    MemberRoleIn,
    ReceivedInviteOut,
)
from app.services import members as member_service

router = APIRouter(tags=["team"])
Db = Annotated[Session, Depends(get_db)]
invite_limiter = RateLimiter("invitations")


@router.get("/company/members", response_model=SuccessResponse[list[MemberOut]])
def list_members(ctx: ViewerContext, db: Db):
    """Everyone in the caller's company with their role, oldest member first."""
    return success_response(member_service.list_members(db, ctx))


@router.patch("/company/members/{user_id}", response_model=SuccessResponse[MemberOut])
def change_member_role(user_id: uuid.UUID, payload: MemberRoleIn, ctx: OwnerContext, db: Db):
    """Give a member another role. The last owner can't stop being one."""
    return success_response(member_service.change_member_role(db, ctx, user_id, payload))


@router.delete("/company/members/{user_id}", response_model=SuccessResponse[dict])
def remove_member(user_id: uuid.UUID, ctx: ViewerContext, db: Db):
    """An owner removes a member; anyone removes themselves (leaves). Not the last owner."""
    member_service.remove_member(db, ctx, user_id)
    return success_response({"deleted": True})


@router.get("/company/invites", response_model=SuccessResponse[list[InviteOut]])
def list_invites(ctx: OwnerContext, db: Db):
    """Open invitations, newest first; expired ones are marked and can be sent again."""
    return success_response(member_service.list_invites(db, ctx))


@router.post("/company/invites", response_model=SuccessResponse[InviteSentOut], status_code=201)
def invite_member(payload: InviteIn, ctx: OwnerContext, db: Db):
    """Invite an email address with a role and email them a link. Inviting the same address
    again renews the invitation with the new role."""
    invite_limiter.check(str(ctx.user.id), get_settings().member_invites_per_hour)
    return success_response(member_service.invite_member(db, ctx, payload))


@router.delete("/company/invites/{invite_id}", response_model=SuccessResponse[dict])
def revoke_invite(invite_id: uuid.UUID, ctx: OwnerContext, db: Db):
    member_service.revoke_invite(db, ctx, invite_id)
    return success_response({"deleted": True})


@router.get("/me/invites", response_model=SuccessResponse[list[ReceivedInviteOut]])
def list_received_invites(user: CurrentUser, db: Db):
    """Invitations to the caller's verified email address that haven't expired."""
    return success_response(member_service.list_received_invites(db, user))


@router.post("/me/invites/{invite_id}/accept", response_model=SuccessResponse[AccountOut])
def accept_invite(invite_id: uuid.UUID, user: CurrentUser, db: Db):
    """Join the inviting company with the invitation's role, instead of onboarding."""
    company, role = member_service.accept_invite(db, user, invite_id)
    return success_response(
        AccountOut(
            user=UserOut.model_validate(user),
            company=CompanyOut.model_validate(company),
            role=role,
            onboarded=True,
        )
    )


@router.delete("/me/invites/{invite_id}", response_model=SuccessResponse[dict])
def decline_invite(invite_id: uuid.UUID, user: CurrentUser, db: Db):
    member_service.decline_invite(db, user, invite_id)
    return success_response({"deleted": True})
