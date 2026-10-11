import uuid

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.context import CompanyContext
from app.core.errors import AppError
from app.database.models import Company, Membership, Role, User
from app.database.queries import audit as audit_queries
from app.database.queries import companies as company_queries
from app.database.queries import users as user_queries
from app.schemas.account import CompanyUpdate, OnboardingIn, UserUpdate


def get_or_create_user(db: Session, *, uid: str, email: str, name: str) -> User:
    """First request from a Firebase user creates their Postgres row."""
    user = user_queries.get_user_by_firebase_uid(db, uid)
    if user:
        if user.email != email:  # email changed in Firebase
            user.email = email
            db.commit()
        return user
    try:
        user = user_queries.create_user(db, firebase_uid=uid, email=email, name=name)
        db.commit()
    except IntegrityError:  # two first requests at once
        db.rollback()
        user = user_queries.get_user_by_firebase_uid(db, uid)
    return user


def find_user_company_membership(
    db: Session, user_id: uuid.UUID
) -> tuple[Membership, Company] | None:
    return user_queries.get_user_company_membership(db, user_id)


def onboard_user(db: Session, user: User, payload: OnboardingIn) -> tuple[Company, Role]:
    """Create the user's company and make them its owner."""
    if user_queries.get_user_company_membership(db, user.id):
        raise AppError(409, "already_onboarded", "You already belong to a company.")
    company = company_queries.create_company(
        db,
        name=payload.company_name,
        business_role=payload.business_role,
        origin=payload.origin,
        destination=payload.destination,
        currency=payload.currency,
    )
    user_queries.add_membership(db, user_id=user.id, company_id=company.id, role=Role.owner)
    audit_queries.record_audit_event(
        db,
        company_id=company.id,
        user_id=user.id,
        action="company.created",
        object_type="company",
        object_id=str(company.id),
        data=payload.model_dump(),
    )
    db.commit()
    return company, Role.owner


def update_user_profile(db: Session, user: User, payload: UserUpdate) -> User:
    for field, value in payload.model_dump(exclude_unset=True, exclude_none=True).items():
        setattr(user, field, value)
    db.commit()
    return user


def update_company_profile(db: Session, ctx: CompanyContext, payload: CompanyUpdate) -> Company:
    changes = payload.model_dump(exclude_unset=True, exclude_none=True)
    for field, value in changes.items():
        setattr(ctx.company, field, value)
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action="company.updated",
        object_type="company",
        object_id=str(ctx.company_id),
        data=changes,
    )
    db.commit()
    return ctx.company
