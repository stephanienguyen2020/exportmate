"""Demo sandboxes: each demo visitor (Firebase anonymous sign-in) gets their own copy of the
demo company, so every feature works on real data without one visitor seeing or changing
another's. A sandbox starts with the company's profile, playbook rules, suppliers and sites but
no orders: the visitor imports the sample orders (frontend/public/samples/) through the
normal import, which analyses them. It is deleted once `demo_expires_at` passes; every company table
cascades from `companies`, and the knowledge graph's full sync drops companies that are gone.
"""

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.context import CompanyContext
from app.database.models import Company, Membership, Role, User
from app.seed_demo_data import (
    load_demo_company_seed,
    seed_company_map_data,
    seed_company_profile,
)
from app.services import accounts
from app.services import playbook as playbook_service

log = logging.getLogger(__name__)


def delete_expired_sandboxes(db: Session, limit: int | None = None) -> int:
    """Deletes sandboxes whose time is up, oldest first, and their visitors' user rows (a demo
    visitor belongs to nothing else). Returns how many were deleted."""
    now = datetime.now(UTC)
    query = (
        select(Company.id)
        .where(Company.demo_expires_at.is_not(None), Company.demo_expires_at <= now)
        .order_by(Company.demo_expires_at)
    )
    if limit is not None:
        query = query.limit(limit)
    company_ids = list(db.scalars(query))
    if not company_ids:
        return 0
    user_ids = list(
        db.scalars(select(Membership.user_id).where(Membership.company_id.in_(company_ids)))
    )
    db.execute(delete(Company).where(Company.id.in_(company_ids)))
    if user_ids:
        db.execute(delete(User).where(User.id.in_(user_ids)))
    db.commit()
    log.info("demo.sandboxes_deleted", extra={"companies": len(company_ids)})
    return len(company_ids)


def current_sandbox(db: Session, user: User) -> tuple[Company, Role] | None:
    """The visitor's sandbox while it lasts. An expired one is deleted here, so the visitor
    can open a new one."""
    found = accounts.find_user_company_membership(db, user.id)
    if not found:
        return None
    membership, company = found
    if company.demo_expires_at is None or company.demo_expires_at > datetime.now(UTC):
        return company, membership.role
    db.execute(delete(Company).where(Company.id == company.id))
    db.commit()
    log.info("demo.sandbox_replaced", extra={"company_id": str(company.id)})
    return None


def open_sandbox(db: Session, user: User) -> tuple[Company, Role]:
    """The visitor's sandbox: theirs if they still have one, else a new copy of the demo
    company that lasts demo_sandbox_hours."""
    settings = get_settings()
    current = current_sandbox(db, user)
    if current:
        return current
    delete_expired_sandboxes(db, settings.demo_cleanup_batch)

    seed = load_demo_company_seed("binh-duong")
    if not user.name:
        user.name = seed.owner_name
    company, role = accounts.onboard_user(db, user, seed.onboarding)
    company.demo_expires_at = datetime.now(UTC) + timedelta(hours=settings.demo_sandbox_hours)
    db.commit()
    ctx = CompanyContext(user=user, company=company, role=role)
    # Each step commits, so a failure part-way would leave a half-built sandbox that the
    # visitor gets back on every later call: delete it instead, and the next call starts over.
    try:
        for rule in seed.rules:
            playbook_service.create_playbook_rule(db, ctx, rule)
        seed_company_profile(db, ctx, seed.profile)
        seed_company_map_data(db, company.id, seed.seed_file)
    except Exception:
        db.rollback()
        db.execute(delete(Company).where(Company.id == company.id))
        db.commit()
        log.exception("demo.sandbox_seed_failed", extra={"company_id": str(company.id)})
        raise
    log.info("demo.sandbox_opened", extra={"company_id": str(company.id), "user_id": str(user.id)})
    return company, role
