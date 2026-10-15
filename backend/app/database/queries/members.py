import uuid
from datetime import datetime

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.database.models import Company, CompanyInvite, Membership, Role, User


def list_company_members(db: Session, company_id: uuid.UUID) -> list[tuple[Membership, User]]:
    """Oldest member first, so the company's creator leads the list."""
    rows = db.execute(
        select(Membership, User)
        .join(User, User.id == Membership.user_id)
        .where(Membership.company_id == company_id)
        .order_by(Membership.created_at, User.email)
    ).all()
    return [(membership, user) for membership, user in rows]


def get_company_member(
    db: Session, company_id: uuid.UUID, user_id: uuid.UUID
) -> tuple[Membership, User] | None:
    row = db.execute(
        select(Membership, User)
        .join(User, User.id == Membership.user_id)
        .where(Membership.company_id == company_id, Membership.user_id == user_id)
    ).first()
    return (row[0], row[1]) if row else None


def get_company_member_by_email(db: Session, company_id: uuid.UUID, email: str) -> User | None:
    return db.scalar(
        select(User)
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.company_id == company_id, func.lower(User.email) == email)
    )


def lock_company_memberships(db: Session, company_id: uuid.UUID) -> None:
    """Row locks on every membership of the company until commit, so two owners changing roles
    at once can't both remove the last other owner."""
    db.execute(
        select(Membership.user_id).where(Membership.company_id == company_id).with_for_update()
    )


def count_company_owners(db: Session, company_id: uuid.UUID) -> int:
    return db.scalar(
        select(func.count())
        .select_from(Membership)
        .where(Membership.company_id == company_id, Membership.role == Role.owner)
    )


def delete_membership(db: Session, company_id: uuid.UUID, user_id: uuid.UUID) -> None:
    db.execute(
        delete(Membership).where(Membership.company_id == company_id, Membership.user_id == user_id)
    )


def list_company_invites(
    db: Session, company_id: uuid.UUID
) -> list[tuple[CompanyInvite, User | None]]:
    """Newest first, expired ones included (inviting the address again renews them)."""
    rows = db.execute(
        select(CompanyInvite, User)
        .outerjoin(User, User.id == CompanyInvite.invited_by_user_id)
        .where(CompanyInvite.company_id == company_id)
        .order_by(CompanyInvite.created_at.desc(), CompanyInvite.email)
    ).all()
    return [(invite, inviter) for invite, inviter in rows]


def count_company_invites(db: Session, company_id: uuid.UUID) -> int:
    return db.scalar(
        select(func.count())
        .select_from(CompanyInvite)
        .where(CompanyInvite.company_id == company_id)
    )


def get_company_invite(
    db: Session, company_id: uuid.UUID, invite_id: uuid.UUID
) -> CompanyInvite | None:
    return db.scalar(
        select(CompanyInvite).where(
            CompanyInvite.company_id == company_id, CompanyInvite.id == invite_id
        )
    )


def get_company_invite_by_email(
    db: Session, company_id: uuid.UUID, email: str, *, for_update: bool = False
) -> CompanyInvite | None:
    stmt = select(CompanyInvite).where(
        CompanyInvite.company_id == company_id, CompanyInvite.email == email
    )
    return db.scalar(stmt.with_for_update() if for_update else stmt)


def create_company_invite(
    db: Session,
    *,
    company_id: uuid.UUID,
    email: str,
    role: Role,
    invited_by_user_id: uuid.UUID,
    expires_at: datetime,
) -> CompanyInvite:
    invite = CompanyInvite(
        company_id=company_id,
        email=email,
        role=role,
        invited_by_user_id=invited_by_user_id,
        expires_at=expires_at,
    )
    db.add(invite)
    db.flush()
    return invite


def list_invites_for_email(
    db: Session, email: str, now: datetime
) -> list[tuple[CompanyInvite, Company, User | None]]:
    """Invitations to this address that haven't expired, newest first."""
    rows = db.execute(
        select(CompanyInvite, Company, User)
        .join(Company, Company.id == CompanyInvite.company_id)
        .outerjoin(User, User.id == CompanyInvite.invited_by_user_id)
        .where(CompanyInvite.email == email, CompanyInvite.expires_at > now)
        .order_by(CompanyInvite.created_at.desc())
    ).all()
    return [(invite, company, inviter) for invite, company, inviter in rows]


def get_invite_for_email(
    db: Session, invite_id: uuid.UUID, email: str, *, for_update: bool = False
) -> CompanyInvite | None:
    stmt = select(CompanyInvite).where(CompanyInvite.id == invite_id, CompanyInvite.email == email)
    return db.scalar(stmt.with_for_update() if for_update else stmt)


def delete_invite(db: Session, invite: CompanyInvite) -> None:
    db.delete(invite)
    db.flush()
