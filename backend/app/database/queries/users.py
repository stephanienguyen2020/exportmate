import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database.models import Company, Membership, Role, User


def get_user_by_firebase_uid(db: Session, firebase_uid: str) -> User | None:
    return db.scalar(select(User).where(User.firebase_uid == firebase_uid))


def create_user(db: Session, *, firebase_uid: str, email: str, name: str) -> User:
    user = User(firebase_uid=firebase_uid, email=email, name=name)
    db.add(user)
    db.flush()
    return user


def get_user_company_membership(
    db: Session, user_id: uuid.UUID
) -> tuple[Membership, Company] | None:
    """The user's company. Phase 1: one company per user, so take the oldest membership."""
    row = db.execute(
        select(Membership, Company)
        .join(Company, Company.id == Membership.company_id)
        .where(Membership.user_id == user_id)
        .order_by(Membership.created_at)
        .limit(1)
    ).first()
    return (row[0], row[1]) if row else None


def add_membership(
    db: Session, *, user_id: uuid.UUID, company_id: uuid.UUID, role: Role
) -> Membership:
    membership = Membership(user_id=user_id, company_id=company_id, role=role)
    db.add(membership)
    db.flush()
    return membership
