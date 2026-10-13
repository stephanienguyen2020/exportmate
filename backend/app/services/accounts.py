import logging
import uuid

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.context import CompanyContext
from app.core.errors import AppError
from app.database.models import Company, Membership, Role, User
from app.database.queries import audit as audit_queries
from app.database.queries import companies as company_queries
from app.database.queries import trade_map as map_queries
from app.database.queries import users as user_queries
from app.schemas.account import (
    CompanyKnowledgeOut,
    CompanyOut,
    CompanySiteOut,
    CompanyUpdate,
    OnboardingIn,
    UserUpdate,
)

log = logging.getLogger(__name__)


def get_or_create_user(db: Session, *, uid: str, email: str, name: str) -> User:
    """First request from a Firebase user creates their Postgres row."""
    user = user_queries.get_user_by_firebase_uid(db, uid)
    if user:
        if user.email != email:  # email changed in Firebase
            user.email = email
            db.commit()
            log.info("account.email_synced", extra={"user_id": str(user.id)})
        return user
    try:
        user = user_queries.create_user(db, firebase_uid=uid, email=email, name=name)
        db.commit()
        log.info("account.user_created", extra={"user_id": str(user.id)})
    except IntegrityError:  # two first requests at once
        db.rollback()
        user = user_queries.get_user_by_firebase_uid(db, uid)
        log.info("account.user_created_concurrently", extra={"user_id": str(user.id)})
    return user


def find_user_company_membership(
    db: Session, user_id: uuid.UUID
) -> tuple[Membership, Company] | None:
    return user_queries.get_user_company_membership(db, user_id)


def onboard_user(db: Session, user: User, payload: OnboardingIn) -> tuple[Company, Role]:
    """Create the user's company and make them its owner."""
    # Two onboarding requests at once (double submit, two tabs) would both pass the check below.
    user_queries.lock_user(db, user.id)
    if user_queries.get_user_company_membership(db, user.id):
        raise AppError(409, "already_onboarded", "You already belong to a company.")
    company = company_queries.create_company(
        db,
        name=payload.company_name,
        business_role=payload.business_role,
        origin=payload.origin,
        transit=payload.transit,
        destination=payload.destination,
        currency=payload.currency,
        description=payload.description,
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
    log.info(
        "account.company_created", extra={"company_id": str(company.id), "user_id": str(user.id)}
    )
    return company, Role.owner


def update_user_profile(db: Session, user: User, payload: UserUpdate) -> User:
    changes = payload.model_dump(exclude_unset=True, exclude_none=True)
    for field, value in changes.items():
        setattr(user, field, value)
    db.commit()
    log.info("account.profile_updated", extra={"user_id": str(user.id), "fields": sorted(changes)})
    return user


def update_company_profile(db: Session, ctx: CompanyContext, payload: CompanyUpdate) -> Company:
    # Only fields that were sent; null clears an optional field (website, year, team size).
    changes = payload.model_dump(exclude_unset=True)
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
    log.info(
        "account.company_updated",
        extra={"company_id": str(ctx.company_id), "fields": sorted(changes)},
    )
    return ctx.company


def build_company_knowledge(db: Session, ctx: CompanyContext) -> CompanyKnowledgeOut:
    """The company profile and sites, for the AI assistant. Read through the API only."""
    sites = map_queries.list_company_sites(db, ctx.company_id)
    company = CompanyOut.model_validate(ctx.company)
    profile_fields = ("description", "products", "materials", "certifications", "website")
    log.info(
        "company.knowledge_served",
        extra={
            "company_id": str(ctx.company_id),
            "filled_fields": sum(bool(getattr(company, f)) for f in profile_fields),
            "sites": len(sites),
        },
    )
    return CompanyKnowledgeOut(
        company=company,
        sites=[CompanySiteOut(name=s.name, kind=s.kind, place=s.place) for s in sites],
    )
