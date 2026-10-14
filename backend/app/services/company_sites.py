"""A company's own sites (factories, ports, warehouses), entered in the trade map.

At most one site is the route origin: order routes on the world map start there, and route
comparisons measure from it. Marking another site moves the origin.
"""

import logging
import re
import uuid

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.context import CompanyContext
from app.core.errors import AppError, not_found_error
from app.database.models import CompanySite
from app.database.queries import audit as audit_queries
from app.database.queries import trade_map as map_queries
from app.schemas.trade_map import SiteIn, SiteOut, SiteUpdate
from app.services.trade_map import site_out

log = logging.getLogger(__name__)

SITE_KEY_LENGTH = 50


def _check_country(db: Session, code: str | None) -> None:
    if code is not None and not map_queries.get_country(db, code):
        raise AppError(
            422,
            "invalid_input",
            "Some fields are invalid.",
            {"country": "Not a country on the map"},
        )


def new_site_key(name: str, taken: set[str]) -> str:
    """A readable, stable key from the name ("Cat Lai warehouse" -> "cat-lai-warehouse").

    Flood observations name nearby sites by key, so a key never changes after creation."""
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[: SITE_KEY_LENGTH - 4] or "site"
    key, n = base, 2
    while key in taken:
        key, n = f"{base}-{n}", n + 1
    return key


def _record_change(db: Session, ctx: CompanyContext, action: str, site: CompanySite) -> None:
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action=action,
        object_type="company_site",
        object_id=str(site.id),
        data={"name": site.name, "kind": site.kind.value, "isRouteOrigin": site.is_route_origin},
    )
    db.commit()
    log.info(
        action,
        extra={
            "company_id": str(ctx.company_id),
            "site_id": str(site.id),
            "route_origin": site.is_route_origin,
        },
    )


def create_site(db: Session, ctx: CompanyContext, payload: SiteIn) -> SiteOut:
    _check_country(db, payload.country)
    if payload.is_route_origin:
        map_queries.clear_route_origin(db, ctx.company_id)
    taken = map_queries.list_company_site_keys(db, ctx.company_id)
    site = CompanySite(
        company_id=ctx.company_id,
        site_key=new_site_key(payload.name, taken),
        kind=payload.kind,
        name=payload.name,
        short_name=payload.short_name or payload.name[:60].strip(),
        place=payload.place,
        country_alpha2=payload.country,
        latitude=payload.location.latitude,
        longitude=payload.location.longitude,
        note=payload.note,
        is_route_origin=payload.is_route_origin,
    )
    try:
        map_queries.add_company_site(db, site)
    except IntegrityError:
        # Two sites with the same name added at once took the same key.
        db.rollback()
        raise AppError(
            409, "conflict", "Another change happened at the same time. Try again."
        ) from None
    _record_change(db, ctx, "company_site.created", site)
    return site_out(site)


def update_site(
    db: Session, ctx: CompanyContext, site_id: uuid.UUID, payload: SiteUpdate
) -> SiteOut:
    site = map_queries.get_company_site(db, ctx.company_id, site_id)
    if not site:
        raise not_found_error("Site")
    sent = payload.model_fields_set
    if "country" in sent:
        _check_country(db, payload.country)
        site.country_alpha2 = payload.country
    if payload.is_route_origin and not site.is_route_origin:
        map_queries.clear_route_origin(db, ctx.company_id)
    if payload.location is not None:
        site.latitude, site.longitude = payload.location.latitude, payload.location.longitude
    for field in ("kind", "name", "short_name", "place", "note", "is_route_origin"):
        if field in sent:
            setattr(site, field, getattr(payload, field))
    db.flush()
    _record_change(db, ctx, "company_site.updated", site)
    return site_out(site)


def delete_site(db: Session, ctx: CompanyContext, site_id: uuid.UUID) -> None:
    site = map_queries.get_company_site(db, ctx.company_id, site_id)
    if not site:
        raise not_found_error("Site")
    map_queries.delete_company_site(db, site)
    _record_change(db, ctx, "company_site.deleted", site)
