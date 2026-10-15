"""The company's team: who belongs, with which role, and invitations to join.

Owners invite an email address with a role; whoever signs in with that address (Firebase has
verified it) accepts and joins instead of onboarding a company of their own. v1 keeps one
company per user, so someone who already belongs to a company can't accept until they leave it.
A company always keeps at least one owner.
"""

import html
import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.context import CompanyContext
from app.core.email import OutgoingEmail, get_email_sender
from app.core.errors import AppError
from app.database.models import Company, CompanyInvite, Role, User
from app.database.queries import audit as audit_queries
from app.database.queries import members as member_queries
from app.database.queries import users as user_queries
from app.schemas.members import (
    InviteIn,
    InviteOut,
    InviteSentOut,
    MemberOut,
    MemberRoleIn,
    PersonOut,
    ReceivedInviteOut,
)

# A company can't have more open invitations than this; revoke some first.
MAX_OPEN_INVITES = 50
ROLE_SUMMARIES = {
    Role.viewer: "read the workspace and prepare reports",
    Role.editor: (
        "import orders, edit the playbook, suppliers and sites, upload documents and run analysis"
    ),
    Role.owner: (
        "do everything an editor does, and edit the company, approve supplier messages and "
        "manage the team"
    ),
}

log = logging.getLogger(__name__)


def _person(user: User | None) -> PersonOut | None:
    return PersonOut(id=user.id, name=user.name or user.email) if user else None


def _member_out(ctx: CompanyContext, membership, user: User) -> MemberOut:
    return MemberOut(
        user_id=user.id,
        name=user.name,
        email=user.email,
        role=membership.role,
        joined_at=membership.created_at,
        you=user.id == ctx.user.id,
    )


def _invite_out(invite: CompanyInvite, inviter: User | None, now: datetime) -> InviteOut:
    return InviteOut(
        id=invite.id,
        email=invite.email,
        role=invite.role,
        invited_by=_person(inviter),
        created_at=invite.created_at,
        expires_at=invite.expires_at,
        expired=invite.expires_at <= now,
    )


def list_members(db: Session, ctx: CompanyContext) -> list[MemberOut]:
    return [
        _member_out(ctx, membership, user)
        for membership, user in member_queries.list_company_members(db, ctx.company_id)
    ]


def _keep_an_owner(db: Session, ctx: CompanyContext, membership, losing_owner: bool) -> None:
    if (
        losing_owner
        and membership.role == Role.owner
        and member_queries.count_company_owners(db, ctx.company_id) <= 1
    ):
        raise AppError(
            409,
            "last_owner",
            "A company needs at least one owner. Make someone else an owner first.",
        )


def change_member_role(
    db: Session, ctx: CompanyContext, user_id: uuid.UUID, payload: MemberRoleIn
) -> MemberOut:
    member_queries.lock_company_memberships(db, ctx.company_id)
    found = member_queries.get_company_member(db, ctx.company_id, user_id)
    if not found:
        raise AppError(404, "member_not_found", "No such member in your company.")
    membership, user = found
    previous = membership.role
    if previous == payload.role:
        return _member_out(ctx, membership, user)
    _keep_an_owner(db, ctx, membership, losing_owner=payload.role != Role.owner)
    membership.role = payload.role
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action="member.role_changed",
        object_type="member",
        object_id=str(user.id),
        data={
            "name": user.name,
            "email": user.email,
            "from": previous.value,
            "to": payload.role.value,
        },
    )
    db.commit()
    log.info(
        "member.role_changed",
        extra={
            "company_id": str(ctx.company_id),
            "member_id": str(user.id),
            "from_role": previous.value,
            "to_role": payload.role.value,
        },
    )
    return _member_out(ctx, membership, user)


def remove_member(db: Session, ctx: CompanyContext, user_id: uuid.UUID) -> None:
    """An owner removes anyone; anyone else can only leave. The person keeps their sign-in and
    can onboard a company of their own or accept another invitation."""
    leaving = user_id == ctx.user.id
    if not leaving and ctx.role != Role.owner:
        raise AppError(403, "forbidden", "This needs the owner role.")
    member_queries.lock_company_memberships(db, ctx.company_id)
    found = member_queries.get_company_member(db, ctx.company_id, user_id)
    if not found:
        raise AppError(404, "member_not_found", "No such member in your company.")
    membership, user = found
    _keep_an_owner(db, ctx, membership, losing_owner=True)
    member_queries.delete_membership(db, ctx.company_id, user_id)
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action="member.left" if leaving else "member.removed",
        object_type="member",
        object_id=str(user.id),
        data={"name": user.name, "email": user.email, "role": membership.role.value},
    )
    db.commit()
    log.info(
        "member.left" if leaving else "member.removed",
        extra={
            "company_id": str(ctx.company_id),
            "member_id": str(user.id),
            "role": membership.role.value,
        },
    )


def list_invites(db: Session, ctx: CompanyContext) -> list[InviteOut]:
    now = datetime.now(UTC)
    return [
        _invite_out(invite, inviter, now)
        for invite, inviter in member_queries.list_company_invites(db, ctx.company_id)
    ]


def _invite_email(ctx: CompanyContext, invite: CompanyInvite) -> OutgoingEmail:
    settings = get_settings()
    inviter = ctx.user.name or ctx.user.email
    link = f"{settings.app_url.rstrip('/')}/#/login"
    expires = invite.expires_at.strftime("%d %B %Y")
    lines = [
        f"{inviter} invited you to join {ctx.company.name} on ExportMate as {invite.role.value}.",
        f"As {invite.role.value} you can {ROLE_SUMMARIES[invite.role]}.",
        (
            f"Sign in, or create an account, with this email address ({invite.email}) to "
            f"accept. The invitation is valid until {expires}."
        ),
    ]
    text = "\n\n".join([*lines, link]) + "\n\n--\nSent with ExportMate."
    body = "".join(f"<p>{html.escape(line)}</p>" for line in lines)
    button = f'<p><a href="{html.escape(link)}">Open ExportMate</a></p>'
    footer = '<p style="color:#777;font-size:12px">Sent with ExportMate.</p>'
    # Company and person names come from user input; a subject is one line.
    subject = " ".join(f"{inviter} invited you to {ctx.company.name} on ExportMate".split())
    return OutgoingEmail(
        to=[invite.email],
        subject=subject[:200],
        html=f'<div style="font-family:sans-serif;font-size:14px">{body}{button}{footer}</div>',
        text=text,
        reply_to=ctx.user.email or None,
    )


def invite_member(db: Session, ctx: CompanyContext, payload: InviteIn) -> InviteSentOut:
    """Invite an address, or renew (new role, new expiry, email again) an earlier invitation."""
    if member_queries.get_company_member_by_email(db, ctx.company_id, payload.email):
        raise AppError(409, "already_member", "This person is already in your company.")
    now = datetime.now(UTC)
    expires_at = now + timedelta(days=get_settings().member_invite_days)
    invite = member_queries.get_company_invite_by_email(
        db, ctx.company_id, payload.email, for_update=True
    )
    renewed = invite is not None
    if invite:
        invite.role = payload.role
        invite.invited_by_user_id = ctx.user.id
        invite.expires_at = expires_at
    else:
        if member_queries.count_company_invites(db, ctx.company_id) >= MAX_OPEN_INVITES:
            raise AppError(
                409,
                "too_many_invites",
                f"Your company has {MAX_OPEN_INVITES} open invitations. Revoke some first.",
            )
        invite = member_queries.create_company_invite(
            db,
            company_id=ctx.company_id,
            email=payload.email,
            role=payload.role,
            invited_by_user_id=ctx.user.id,
            expires_at=expires_at,
        )
    # Sent before the commit: if the email fails, no invitation is saved and the owner retries.
    receipt = get_email_sender().send_email(_invite_email(ctx, invite))
    # The address stays in the company's audit trail, never in logs.
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action="member.invited",
        object_type="invite",
        object_id=str(invite.id),
        data={
            "email": invite.email,
            "role": invite.role.value,
            "renewed": renewed,
            "sandbox": receipt.sandbox,
        },
    )
    db.commit()
    db.refresh(invite)
    log.info(
        "member.invited",
        extra={
            "company_id": str(ctx.company_id),
            "invite_id": str(invite.id),
            "role": invite.role.value,
            "renewed": renewed,
            "sandbox": receipt.sandbox,
        },
    )
    out = _invite_out(invite, ctx.user, now)
    return InviteSentOut(**out.model_dump(), sandbox=receipt.sandbox)


def revoke_invite(db: Session, ctx: CompanyContext, invite_id: uuid.UUID) -> None:
    invite = member_queries.get_company_invite(db, ctx.company_id, invite_id)
    if not invite:
        raise AppError(404, "invite_not_found", "No such invitation.")
    member_queries.delete_invite(db, invite)
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action="member.invite_revoked",
        object_type="invite",
        object_id=str(invite_id),
        data={"email": invite.email, "role": invite.role.value},
    )
    db.commit()
    log.info(
        "member.invite_revoked",
        extra={"company_id": str(ctx.company_id), "invite_id": str(invite_id)},
    )


def list_received_invites(db: Session, user: User) -> list[ReceivedInviteOut]:
    now = datetime.now(UTC)
    return [
        ReceivedInviteOut(
            id=invite.id,
            company_name=company.name,
            role=invite.role,
            invited_by=_person(inviter),
            expires_at=invite.expires_at,
        )
        for invite, company, inviter in member_queries.list_invites_for_email(
            db, user.email.lower(), now
        )
    ]


def _received_invite(db: Session, user: User, invite_id: uuid.UUID) -> CompanyInvite:
    invite = member_queries.get_invite_for_email(db, invite_id, user.email.lower(), for_update=True)
    if not invite or invite.expires_at <= datetime.now(UTC):
        raise AppError(
            404,
            "invite_not_found",
            "This invitation has expired or was withdrawn. Ask the company's owner to invite "
            "you again.",
        )
    return invite


def accept_invite(db: Session, user: User, invite_id: uuid.UUID) -> tuple[Company, Role]:
    # Same lock as onboarding: two accepts (or an accept and an onboarding) run one at a time.
    user_queries.lock_user(db, user.id)
    if user_queries.get_user_company_membership(db, user.id):
        raise AppError(
            409,
            "already_in_company",
            "You already belong to a company. Leave it before joining another one.",
        )
    invite = _received_invite(db, user, invite_id)
    company = db.get(Company, invite.company_id)
    role = invite.role
    user_queries.add_membership(db, user_id=user.id, company_id=company.id, role=role)
    member_queries.delete_invite(db, invite)
    audit_queries.record_audit_event(
        db,
        company_id=company.id,
        user_id=user.id,
        action="member.joined",
        object_type="member",
        object_id=str(user.id),
        data={
            "name": user.name,
            "email": user.email,
            "role": role.value,
            "inviteId": str(invite_id),
            "invitedBy": str(invite.invited_by_user_id) if invite.invited_by_user_id else None,
        },
    )
    db.commit()
    log.info(
        "member.joined",
        extra={"company_id": str(company.id), "user_id": str(user.id), "role": role.value},
    )
    return company, role


def decline_invite(db: Session, user: User, invite_id: uuid.UUID) -> None:
    invite = _received_invite(db, user, invite_id)
    company_id = invite.company_id
    member_queries.delete_invite(db, invite)
    audit_queries.record_audit_event(
        db,
        company_id=company_id,
        user_id=user.id,
        action="member.invite_declined",
        object_type="invite",
        object_id=str(invite_id),
        data={"email": invite.email, "role": invite.role.value},
    )
    db.commit()
    log.info(
        "member.invite_declined", extra={"company_id": str(company_id), "invite_id": str(invite_id)}
    )
