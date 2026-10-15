"""Trade map: where a company's orders, suppliers and sites are, which documents each order
still needs in its market, and what changes if an order went to another market.

Geography and market requirements are shared reference tables; suppliers, their documents and
sites belong to one company. Each market requirement cites the shared regulation document that
sets it (docs/REQUIREMENTS.md §4.5). Analysis (services/analysis.py) runs the same check. Observations marked sample are not a live feed.
"""

import logging
import math
import re
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from itertools import pairwise

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.context import CompanyContext
from app.core.errors import AppError, not_found_error
from app.database.models import (
    Company,
    CompanySite,
    Country,
    Market,
    MarketRequirement,
    Order,
    Port,
    RequirementLevel,
    SatelliteObservation,
    Supplier,
    SupplierDocument,
)
from app.database.queries import orders as order_queries
from app.database.queries import regulations as regulation_queries
from app.database.queries import trade_map as map_queries
from app.schemas.orders import OrderOut
from app.schemas.trade_map import (
    CheckStatus,
    ComparisonItemOut,
    CountryOut,
    DocumentKindOut,
    GeoPoint,
    MapOrderOut,
    MapSupplierOut,
    MarketComparisonOut,
    MarketOut,
    NearbyPlaceOut,
    OrderPlacementOut,
    RequirementCheckOut,
    RequirementSourceOut,
    SatelliteObservationOut,
    SiteOut,
    SupplierDocumentOut,
    TradeMapOut,
)

log = logging.getLogger(__name__)

# "Rotterdam, NL", or "Rotterdam NL" as in the CSV template. The code is ISO 3166-1 alpha-2.
_DESTINATION = re.compile(r"^(.*?)[,\s]+([A-Za-z]{2})$")
# ISO reserves "UK" for the United Kingdom, whose code is GB; people write both.
_COUNTRY_ALIASES = {"UK": "GB"}
_GAP_STATUSES = {"missing", "mismatch"}
OBSERVATION_LIMIT = 100
EARTH_RADIUS_KM = 6371.0
# Intermediate stops a comparison can try. "direct" has no hub. Each hub is a seeded port.
ROUTE_HUBS: dict[str, tuple[str, str] | None] = {
    "direct": None,
    "SG": ("Singapore", "SG"),
    "MY": ("Port Klang", "MY"),
    "HK": ("Hong Kong", "HK"),
    "AE": ("Jebel Ali", "AE"),
    "LK": ("Colombo", "LK"),
}

SupplierDocs = dict[str, SupplierDocument]


def supplier_name_key(name: str) -> str:
    """How an order's supplier text matches a supplier record: trimmed, single-spaced, lower."""
    return " ".join(name.split()).lower()


@dataclass(frozen=True)
class Gazetteer:
    """Reference geography, loaded once per request."""

    markets: dict[str, Market]
    countries: dict[str, Country]
    ports: dict[tuple[str, str], Port]  # (lower-case name, country alpha-2)
    ports_by_name: dict[str, Port]  # for destinations written without a country

    @classmethod
    def from_rows(
        cls, markets: list[Market], countries: list[Country], ports: list[Port]
    ) -> "Gazetteer":
        by_name: dict[str, Port] = {}
        for port in ports:
            by_name.setdefault(port.name_key, port)
        return cls(
            markets={m.code: m for m in markets},
            countries={c.alpha2: c for c in countries},
            ports={(p.name_key, p.country_alpha2): p for p in ports},
            ports_by_name=by_name,
        )


def parse_destination(destination: str) -> tuple[str, str | None]:
    """Split "Rotterdam, NL" into ("Rotterdam", "NL"). No country code gives (text, None)."""
    text = destination.strip().rstrip(",").strip()
    match = _DESTINATION.match(text)
    if match:
        code = match.group(2).upper()
        return match.group(1).strip().rstrip(",").strip(), _COUNTRY_ALIASES.get(code, code)
    if len(text) == 2 and text.isalpha():  # just a country code, e.g. "NL"
        code = text.upper()
        return "", _COUNTRY_ALIASES.get(code, code)
    return text, None


def locate_destination(destination: str, gazetteer: Gazetteer) -> OrderPlacementOut:
    city, country = parse_destination(destination)
    key = city.lower()
    port = gazetteer.ports.get((key, country)) if country else gazetteer.ports_by_name.get(key)
    if port:
        country = port.country_alpha2
    record = gazetteer.countries.get(country) if country else None
    market = gazetteer.markets.get(record.market_code) if record and record.market_code else None
    location, approximate = None, False
    if market and port:
        location = GeoPoint(latitude=port.latitude, longitude=port.longitude)
    elif market:
        approximate = True
        location = (
            GeoPoint(latitude=record.center_latitude, longitude=record.center_longitude)
            if record.center_latitude is not None and record.center_longitude is not None
            else GeoPoint(latitude=market.hub_latitude, longitude=market.hub_longitude)
        )
    return OrderPlacementOut(
        city=port.name if port else city or (record.name if record else destination.strip()),
        country=country,
        market=market.code if market else None,
        location=location,
        approximate=approximate,
    )


def applies_to(requirement: MarketRequirement, hs_code: str) -> bool:
    digits = re.sub(r"\D", "", hs_code)
    return not requirement.hs_prefixes or any(digits.startswith(p) for p in requirement.hs_prefixes)


def applies_on(requirement: MarketRequirement, on: date) -> bool:
    """A line with effective_on applies on that day and after. No date means already in force."""
    return requirement.effective_on is None or on >= requirement.effective_on


def _check_requirement(
    requirement: MarketRequirement, order: Order, documents: SupplierDocs | None
) -> tuple[CheckStatus, str]:
    if requirement.level == RequirementLevel.shipment:
        return "prepare", requirement.form or requirement.why
    if requirement.level == RequirementLevel.check:
        return "check", requirement.why
    if documents is None:
        return "unknown", "No document record for this supplier."
    record = documents.get(requirement.document_kind) if requirement.document_kind else None
    if record is None:
        return "missing", f"Not on file from {order.supplier}."
    if record.expires_on and record.expires_on < order.ship_date:
        return (
            "mismatch",
            f"On file, but it expires on {record.expires_on.isoformat()}, before the ship date.",
        )
    accepted = requirement.accepted_standards
    if accepted and not set(record.standards) & set(accepted):
        on_file = ", ".join(record.standards) or "untested"
        return "mismatch", f"On file: {on_file}. Expected: {' or '.join(accepted)}."
    return "on_file", record.detail


def _evaluate(
    order: Order, requirements: list[MarketRequirement], documents: SupplierDocs | None
) -> list[tuple[MarketRequirement, CheckStatus, str]]:
    return [
        (req, *_check_requirement(req, order, documents))
        for req in requirements
        if applies_to(req, order.hs_code) and applies_on(req, order.ship_date)
    ]


def check_order(
    order: Order,
    requirements: list[MarketRequirement],
    documents: SupplierDocs | None,
    sources: dict[uuid.UUID, RequirementSourceOut],
) -> list[RequirementCheckOut]:
    """`documents` None means no supplier record: supplier evidence is "unknown", not missing.

    `sources` maps a regulation document id to its citation; each check adds its market
    requirement's quote."""
    return [
        RequirementCheckOut(
            requirement_key=req.requirement_key,
            title=req.title,
            level=req.level,
            status=status,
            note=note,
            source=sources[req.regulation_document_id].model_copy(
                update={"quote": req.source_quote}
            ),
        )
        for req, status, note in _evaluate(order, requirements, documents)
    ]


def compare_requirements(
    order: Order,
    from_market: Market | None,
    from_requirements: list[MarketRequirement],
    to_market: Market,
    to_requirements: list[MarketRequirement],
    documents: SupplierDocs | None,
) -> MarketComparisonOut:
    """Paperwork only: which documents carry over, what needs another look, what we can't tell."""
    current = from_market.code if from_market else None
    before = {
        r.requirement_key: r
        for r in from_requirements
        if applies_to(r, order.hs_code) and applies_on(r, order.ship_date)
    }
    reuse: list[ComparisonItemOut] = []
    reevaluate: list[ComparisonItemOut] = []
    unknown: list[ComparisonItemOut] = []
    after = _evaluate(order, to_requirements, documents)
    for req, status, note in after:
        prior = before.get(req.requirement_key)
        new_tag = None if prior else "New"
        if status == "on_file":
            reuse.append(
                ComparisonItemOut(
                    title=req.title,
                    note=f"{note}. "
                    + (
                        f"Also listed in the {current} checklist; validity and shipment scope still need review."
                        if prior
                        else f"{to_market.name} asks for it; "
                        + (f"the {current} checklist" if current else "the current market")
                        + " doesn't. Check it covers this shipment."
                    ),
                )
            )
        elif status == "missing":
            reevaluate.append(
                ComparisonItemOut(
                    title=req.title, note=f"{note} Request it before quoting.", tag=new_tag
                )
            )
        elif status == "mismatch":
            reevaluate.append(
                ComparisonItemOut(title=req.title, note=note, tag=new_tag or "Changes")
            )
        elif status == "prepare":
            if prior and prior.form == req.form:
                reevaluate.append(
                    ComparisonItemOut(
                        title=req.title,
                        note="Same requirement, but shipment-specific evidence still needs to be "
                        "prepared and checked for this order.",
                        tag="Prepare",
                    )
                )
            else:
                reevaluate.append(
                    ComparisonItemOut(
                        title=req.title,
                        note=f"Re-issue: {prior.form} → {req.form}."
                        if prior
                        else f"{req.form}. {req.why}",
                        tag=new_tag or "Changes",
                    )
                )
        elif status == "check":
            reevaluate.append(ComparisonItemOut(title=req.title, note=req.why, tag=new_tag))
        else:
            unknown.append(
                ComparisonItemOut(
                    title=req.title,
                    note=f"No document record for {order.supplier}, so reuse can't be confirmed.",
                )
            )
    kept = {req.requirement_key for req, _, _ in after}
    unknown += [
        ComparisonItemOut(
            title="Buyer and contract terms",
            note=f"Certifications, labelling or testing a {to_market.name} buyer adds aren't in "
            "your data.",
        ),
        ComparisonItemOut(
            title="Import duty",
            note=f"Depends on the {to_market.name} tariff line for HS {order.hs_code} and the "
            "origin preference used.",
        ),
    ]
    if len(after) <= 2:
        unknown.append(
            ComparisonItemOut(
                title="A short checklist",
                note=f"The checklist for {to_market.name} is short. That doesn't mean nothing "
                "else applies.",
            )
        )
    return MarketComparisonOut(
        order_id=order.external_id,
        from_market=current,
        to_market=to_market.code,
        reuse=reuse,
        reevaluate=reevaluate,
        unknown=unknown,
        dropped=[r.title for key, r in before.items() if key not in kept],
    )


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    rad = math.pi / 180
    a = (
        math.sin((lat2 - lat1) * rad / 2) ** 2
        + math.cos(lat1 * rad) * math.cos(lat2 * rad) * math.sin((lon2 - lon1) * rad / 2) ** 2
    )
    return EARTH_RADIUS_KM * 2 * math.asin(math.sqrt(min(1.0, max(0.0, a))))


def km_from_extent(observation: SatelliteObservation, latitude: float, longitude: float) -> float:
    """Estimate distance to the mapped polygon, not its bounding circle.

    These local flood extents use a query-centred equirectangular plane. Distances
    are screening estimates, not survey measurements. Polygon holes are excluded.
    Longitudes are unwrapped at the observation centre for antimeridian extents.
    """
    rad = math.pi / 180
    anchor = observation.center_longitude

    def unwrap(lon: float) -> float:
        return (lon - anchor + 180) % 360 - 180

    query_lon = unwrap(longitude)

    def project(coordinate: list[float]) -> tuple[float, float]:
        lon, lat = coordinate[:2]
        return (
            (unwrap(lon) - query_lon) * rad * EARTH_RADIUS_KM * math.cos(latitude * rad),
            (lat - latitude) * rad * EARTH_RADIUS_KM,
        )

    rings = [[project(p) for p in ring] for ring in observation.extent["coordinates"]]

    def contains(ring: list[tuple[float, float]]) -> bool:
        inside = False
        for (ax, ay), (bx, by) in zip(ring, ring[1:] + ring[:1]):
            if (ay > 0) != (by > 0) and 0 < ax + (bx - ax) * (-ay) / (by - ay):
                inside = not inside
        return inside

    if contains(rings[0]) and not any(contains(ring) for ring in rings[1:]):
        return 0.0
    nearest = math.inf
    for ring in rings:
        for (ax, ay), (bx, by) in zip(ring, ring[1:] + ring[:1]):
            dx, dy = bx - ax, by - ay
            length_squared = dx * dx + dy * dy
            fraction = (
                max(0.0, min(1.0, -(ax * dx + ay * dy) / length_squared)) if length_squared else 0.0
            )
            nearest = min(nearest, math.hypot(ax + fraction * dx, ay + fraction * dy))
    return nearest


def nearby_places(
    observation: SatelliteObservation,
    suppliers: list[Supplier],
    sites: list[CompanySite],
    radius_km: float,
) -> list[NearbyPlaceOut]:
    places = [
        ("supplier", s.name, s.name, s.latitude, s.longitude)
        for s in suppliers
        if s.latitude is not None and s.longitude is not None
    ] + [("site", s.site_key, s.name, s.latitude, s.longitude) for s in sites]
    nearby = []
    for kind, ref, name, lat, lon in places:
        km = km_from_extent(observation, lat, lon)
        if km <= radius_km:
            # Apply the threshold before rounding; zero must mean on/inside the polygon.
            nearby.append(NearbyPlaceOut(type=kind, ref=ref, name=name, distance_km=math.ceil(km)))
    return sorted(nearby, key=lambda p: (p.distance_km, p.name))


def load_gazetteer(db: Session) -> Gazetteer:
    return Gazetteer.from_rows(
        map_queries.list_markets(db), map_queries.list_countries(db), map_queries.list_ports(db)
    )


def requirements_by_market(
    db: Session, company_id: uuid.UUID
) -> dict[str, list[MarketRequirement]]:
    """The requirements in force for this company (shared and its own), by market."""
    grouped: dict[str, list[MarketRequirement]] = defaultdict(list)
    for req in map_queries.list_requirements_in_force(db, company_id):
        grouped[req.market_code].append(req)
    return grouped


def load_requirement_sources(
    db: Session, requirements: dict[str, list[MarketRequirement]]
) -> dict[uuid.UUID, RequirementSourceOut]:
    document_ids = list({r.regulation_document_id for reqs in requirements.values() for r in reqs})
    return {
        document.id: RequirementSourceOut(
            regulation_id=regulation.id,
            regulation_title=regulation.title,
            official_id=regulation.official_id,
            document_id=document.id,
            document_title=document.title,
            version_number=document.version_number,
            source_url=document.source_url,
            quote="",
        )
        for document, regulation in regulation_queries.list_documents_with_regulations(
            db, document_ids
        )
    }


def documents_by_supplier(db: Session, suppliers: list[Supplier]) -> dict[uuid.UUID, SupplierDocs]:
    grouped: dict[uuid.UUID, SupplierDocs] = {s.id: {} for s in suppliers}
    for doc in map_queries.list_supplier_documents(db, grouped):
        grouped[doc.supplier_id][doc.kind] = doc
    return grouped


def _point(latitude: float | None, longitude: float | None) -> GeoPoint | None:
    if latitude is None or longitude is None:
        return None
    return GeoPoint(latitude=latitude, longitude=longitude)


def site_out(site: CompanySite) -> SiteOut:
    return SiteOut(
        id=site.id,
        key=site.site_key,
        kind=site.kind,
        name=site.name,
        short_name=site.short_name,
        place=site.place,
        country=site.country_alpha2,
        location=GeoPoint(latitude=site.latitude, longitude=site.longitude),
        note=site.note,
        is_route_origin=site.is_route_origin,
    )


def supplier_documents_out(
    documents: list[SupplierDocument], kinds: dict[str, str]
) -> list[SupplierDocumentOut]:
    return [
        SupplierDocumentOut(
            kind=d.kind,
            label=kinds.get(d.kind, d.kind),
            detail=d.detail,
            standards=d.standards,
            document_number=d.document_number,
            issuer=d.issuer,
            expires_on=d.expires_on,
            from_upload=d.upload_id is not None,
        )
        for d in documents
    ]


def build_trade_map(db: Session, ctx: CompanyContext) -> TradeMapOut:
    started = time.perf_counter()
    radius = get_settings().flood_check_radius_km
    gazetteer = load_gazetteer(db)
    requirements = requirements_by_market(db, ctx.company_id)
    sources = load_requirement_sources(db, requirements)
    kinds = {k.kind: k.label for k in map_queries.list_document_kinds(db)}
    orders = order_queries.list_company_orders(db, ctx.company_id)
    suppliers = map_queries.list_company_suppliers(db, ctx.company_id)
    by_key = {s.name_key: s for s in suppliers}
    documents = documents_by_supplier(db, suppliers)
    sites = map_queries.list_company_sites(db, ctx.company_id)

    map_orders: list[MapOrderOut] = []
    order_ids: dict[str, list[str]] = defaultdict(list)
    names_on_orders: dict[str, str] = {}
    for order in orders:
        key = supplier_name_key(order.supplier)
        order_ids[key].append(order.external_id)
        names_on_orders.setdefault(key, " ".join(order.supplier.split()))
        supplier = by_key.get(key)
        placement = locate_destination(order.destination, gazetteer)
        checks = (
            check_order(
                order,
                requirements.get(placement.market, []),
                documents[supplier.id] if supplier else None,
                sources,
            )
            if placement.market
            else []
        )
        map_orders.append(
            MapOrderOut(
                order=OrderOut.from_order(order),
                placement=placement,
                checks=checks,
                gap_count=sum(c.status in _GAP_STATUSES for c in checks),
            )
        )

    map_suppliers = [
        MapSupplierOut(
            id=s.id,
            name=s.name,
            place=s.place,
            country=s.country_alpha2,
            location=_point(s.latitude, s.longitude),
            supplies=s.supplies,
            contact_name=s.contact_name,
            contact_email=s.contact_email,
            documents=supplier_documents_out(list(documents[s.id].values()), kinds),
            order_ids=order_ids.get(s.name_key, []),
        )
        for s in suppliers
    ]
    unmatched = [key for key in names_on_orders if key not in by_key]
    map_suppliers += [
        MapSupplierOut(
            id=None,
            name=names_on_orders[key],
            place=None,
            country=None,
            location=None,
            supplies=None,
            documents=None,
            order_ids=order_ids[key],
        )
        for key in unmatched
    ]

    observations = map_queries.list_satellite_observations(db, OBSERVATION_LIMIT)
    map_observations = [
        SatelliteObservationOut(
            id=o.id,
            kind=o.kind.value,
            title=o.title,
            place=o.place,
            center=GeoPoint(latitude=o.center_latitude, longitude=o.center_longitude),
            radius_km=o.radius_km,
            area_km2=o.area_km2,
            observed_on=o.observed_on,
            sensor=o.sensor,
            confidence=o.confidence,
            confidence_note=o.confidence_note,
            extent=o.extent,
            is_sample=o.is_sample,
            source_url=o.source_url,
            nearby=nearby_places(o, suppliers, sites, radius),
        )
        for o in observations
    ]

    home = {s.country_alpha2 for s in [*sites, *suppliers] if s.country_alpha2}
    unplaced = sum(m.placement.location is None for m in map_orders)
    log.info(
        "trade_map.built",
        extra={
            "company_id": str(ctx.company_id),
            "orders": len(map_orders),
            "unplaced_orders": unplaced,
            "orders_with_gaps": sum(m.gap_count > 0 for m in map_orders),
            "suppliers": len(suppliers),
            "suppliers_without_record": len(unmatched),
            "sites": len(sites),
            "observations": len(map_observations),
            "observations_near_company": sum(bool(o.nearby) for o in map_observations),
            "duration_ms": round((time.perf_counter() - started) * 1000, 1),
        },
    )
    if not sites:
        log.info("trade_map.no_sites", extra={"company_id": str(ctx.company_id)})

    return TradeMapOut(
        markets=[
            MarketOut(
                code=m.code,
                name=m.name,
                short_name=m.short_name,
                hub=GeoPoint(latitude=m.hub_latitude, longitude=m.hub_longitude),
                country_ids=sorted(
                    c.numeric_code for c in gazetteer.countries.values() if c.market_code == m.code
                ),
                search_terms=m.search_terms,
            )
            for m in gazetteer.markets.values()
        ],
        orders=map_orders,
        suppliers=map_suppliers,
        sites=[site_out(s) for s in sites],
        observations=map_observations,
        document_kinds=[DocumentKindOut(kind=k, label=label) for k, label in kinds.items()],
        countries=sorted(
            (
                CountryOut(code=c.alpha2, numeric_code=c.numeric_code, name=c.name)
                for c in gazetteer.countries.values()
            ),
            key=lambda c: c.name,
        ),
        home_country_ids=sorted(
            gazetteer.countries[c].numeric_code for c in home if c in gazetteer.countries
        ),
        check_radius_km=radius,
    )


def _load_order(db: Session, ctx: CompanyContext, order_id: str) -> Order:
    order = order_queries.get_order_by_external_id(db, ctx.company_id, order_id)
    if not order:
        raise not_found_error("Order")
    return order


def build_order_checklist(
    db: Session, ctx: CompanyContext, order: Order
) -> tuple[MapOrderOut, Market | None]:
    """One order's placement and document checks, exactly as the trade map shows them, and the
    market it ships to (None when the destination isn't in a market on the map)."""
    gazetteer = load_gazetteer(db)
    placement = locate_destination(order.destination, gazetteer)
    market = gazetteer.markets.get(placement.market) if placement.market else None
    checks: list[RequirementCheckOut] = []
    if market:
        requirements = {
            market.code: requirements_by_market(db, ctx.company_id).get(market.code, [])
        }
        checks = check_order(
            order,
            requirements[market.code],
            _supplier_documents(db, ctx, order),
            load_requirement_sources(db, requirements),
        )
    checked = MapOrderOut(
        order=OrderOut.from_order(order),
        placement=placement,
        checks=checks,
        gap_count=sum(c.status in _GAP_STATUSES for c in checks),
    )
    return checked, market


def _supplier_documents(db: Session, ctx: CompanyContext, order: Order) -> SupplierDocs | None:
    supplier = map_queries.get_supplier_by_name_key(
        db, ctx.company_id, supplier_name_key(order.supplier)
    )
    if not supplier:
        return None
    return documents_by_supplier(db, [supplier])[supplier.id]


def _origin_point(
    db: Session, ctx: CompanyContext, gazetteer: Gazetteer
) -> tuple[float, float] | None:
    """Recorded route-origin site, or the company profile's origin country centre."""
    sites = map_queries.list_company_sites(db, ctx.company_id)
    origin = next((site for site in sites if site.is_route_origin), None)
    if origin:
        return origin.latitude, origin.longitude
    company = db.get(Company, ctx.company_id)
    if not company:
        return None
    name = company.origin.casefold()
    for country in gazetteer.countries.values():
        if country.name.casefold() == name and country.center_latitude is not None:
            return country.center_latitude, country.center_longitude
    return None


def _log_comparison(
    ctx: CompanyContext, order: Order, result: MarketComparisonOut, supplier_record: bool
) -> None:
    log.info(
        "trade_map.compared",
        extra={
            "company_id": str(ctx.company_id),
            "order_id": order.external_id,
            "kind": result.kind,
            "from_market": result.from_market,
            "to_market": result.to_market,
            "reuse": len(result.reuse),
            "reevaluate": len(result.reevaluate),
            "unknown": len(result.unknown),
            "supplier_record": supplier_record,
        },
    )


def _classify_unchanged(
    req: MarketRequirement,
    order: Order,
    documents: SupplierDocs | None,
    reuse: list[ComparisonItemOut],
    reevaluate: list[ComparisonItemOut],
    unknown: list[ComparisonItemOut],
) -> None:
    """An unchanged requirement is not evidence that its document is on file."""
    status, note = _check_requirement(req, order, documents)
    if status == "on_file":
        reuse.append(
            ComparisonItemOut(
                title=req.title,
                note=f"{note}. On file; validity and shipment scope still need review.",
            )
        )
    elif status == "unknown":
        unknown.append(ComparisonItemOut(title=req.title, note=note))
    else:
        reevaluate.append(
            ComparisonItemOut(
                title=req.title,
                note=note,
                tag="Prepare" if status == "prepare" else None,
            )
        )


def compare_ship_date(
    db: Session, ctx: CompanyContext, order_id: str, proposed: date
) -> MarketComparisonOut:
    """Which checklist lines start, stop, or change between the planned date and `proposed`.

    Uses the dates written on the checklist. It does not estimate arrival or a buyer's window.
    """
    order = _load_order(db, ctx, order_id)
    if proposed == order.ship_date:
        raise AppError(
            422,
            "same_date",
            f"{order.external_id} is already planned for {proposed.isoformat()}.",
            {"shipDate": "Pick a different date"},
        )
    gazetteer = load_gazetteer(db)
    placement = locate_destination(order.destination, gazetteer)
    requirements = (
        requirements_by_market(db, ctx.company_id).get(placement.market, [])
        if placement.market
        else []
    )
    current, reuse, reevaluate, evidence_unknown = order.ship_date, [], [], []
    documents = _supplier_documents(db, ctx, order)
    for req in requirements:
        if not applies_to(req, order.hs_code):
            continue
        now, then = applies_on(req, current), applies_on(req, proposed)
        crosses = req.changes_on is not None and min(current, proposed) < req.changes_on <= max(
            current, proposed
        )
        if now != then:
            starting = then and not now
            reevaluate.append(
                ComparisonItemOut(
                    title=req.title,
                    note=(
                        f"Listed from {req.effective_on.isoformat()}. "
                        f"{'It applies on the new date.' if starting else 'It does not apply on the new date.'} "
                        f"{req.why}"
                    ),
                    tag="New" if starting else None,
                )
            )
        elif crosses and then:
            reevaluate.append(
                ComparisonItemOut(
                    title=req.title,
                    note=req.change_note or req.why,
                    tag="Changes",
                )
            )
        elif now:
            _classify_unchanged(req, order, documents, reuse, reevaluate, evidence_unknown)
    market = placement.market or ""
    result = MarketComparisonOut(
        order_id=order.external_id,
        kind="ship_date",
        from_market=placement.market,
        to_market=market,
        from_ship_date=current,
        to_ship_date=proposed,
        reuse=reuse,
        reevaluate=reevaluate,
        unknown=evidence_unknown
        + [
            ComparisonItemOut(
                title="Buyer delivery window",
                note="The contract date the buyer will accept is not in this dataset.",
            ),
            ComparisonItemOut(
                title="Arrival date",
                note="Transit time is not in this dataset, so this does not estimate when the goods arrive.",
            ),
        ],
        dropped=[],
        assumptions=[
            "Only the checklist's effective dates and stated change dates are compared.",
            "The destination market and the documents on file stay the same.",
            "A date on a checklist is not a full legal calendar.",
        ],
    )
    if not placement.market:
        result.unknown.insert(
            0,
            ComparisonItemOut(
                title="No mapped market",
                note=f"{order.destination} is not in a market on this map, so there is no checklist to date.",
            ),
        )
    _log_comparison(ctx, order, result, _supplier_documents(db, ctx, order) is not None)
    return result


def compare_route(db: Session, ctx: CompanyContext, order_id: str, via: str) -> MarketComparisonOut:
    """What a different routing changes in the checklist, plus the great-circle distance.

    Freight, sailing time and congestion are not in the dataset and stay unknown.
    """
    code = via.strip()
    code = "direct" if code.casefold() == "direct" else code.upper()
    if code not in ROUTE_HUBS:
        raise AppError(422, "unknown_route", f"Unknown route: {via}.", {"via": "Unknown route"})
    order = _load_order(db, ctx, order_id)
    gazetteer = load_gazetteer(db)
    placement = locate_destination(order.destination, gazetteer)
    hub = ROUTE_HUBS[code]
    if hub and placement.country == hub[1]:
        raise AppError(
            422,
            "same_route",
            f"{hub[0]} is already in the destination country.",
            {"via": "Pick a stop that is not the destination"},
        )
    requirements = (
        requirements_by_market(db, ctx.company_id).get(placement.market, [])
        if placement.market
        else []
    )
    reuse, reevaluate, evidence_unknown = [], [], []
    documents = _supplier_documents(db, ctx, order)
    hub_name = "Direct" if hub is None else hub[0]
    for req in requirements:
        if not applies_to(req, order.hs_code) or not applies_on(req, order.ship_date):
            continue
        if req.route_sensitive and hub is not None:
            reevaluate.append(
                ComparisonItemOut(
                    title=req.title,
                    note=f"A stop in {hub_name} can change the consignment rule for this proof. "
                    "Recheck it for this routing. This is not a new duty calculation.",
                    tag="Changes",
                )
            )
        else:
            _classify_unchanged(req, order, documents, reuse, reevaluate, evidence_unknown)
    points = _route_points(db, ctx, gazetteer, placement, hub)
    distance = (
        round(
            sum(
                distance_km(a.latitude, a.longitude, b.latitude, b.longitude)
                for a, b in pairwise(points)
            )
        )
        if points
        else None
    )
    unknown = evidence_unknown + [
        ComparisonItemOut(
            title="Freight cost",
            note="No rate card is stored, so this does not estimate a price.",
        ),
        ComparisonItemOut(
            title="Sailing time",
            note="No carrier schedule is stored, so this does not estimate days on the water.",
        ),
        ComparisonItemOut(
            title="Port congestion and insurance",
            note="Those risks are not in this dataset. Ask the forwarder before changing the booking.",
        ),
    ]
    assumptions = [
        "The destination market stays the same. Only the path to it changes.",
        "A transshipment does not by itself clear or create a market checklist.",
    ]
    if distance is None:
        unknown.append(
            ComparisonItemOut(
                title="Distance",
                note="The origin, stop or destination could not be located, so no route is estimated.",
            )
        )
    else:
        assumptions.append(
            f"About {distance} km is the great-circle length"
            + (f" via {hub_name}" if hub else "")
            + ". It is not a voyage and not a freight quote."
        )
    market = placement.market or ""
    result = MarketComparisonOut(
        order_id=order.external_id,
        kind="route",
        from_market=placement.market,
        to_market=market,
        via=code,
        via_name=hub_name,
        distance_km=distance,
        route_points=points,
        reuse=reuse,
        reevaluate=reevaluate,
        unknown=unknown,
        dropped=[],
        assumptions=assumptions,
    )
    _log_comparison(ctx, order, result, _supplier_documents(db, ctx, order) is not None)
    return result


def _route_points(
    db: Session,
    ctx: CompanyContext,
    gazetteer: Gazetteer,
    placement: OrderPlacementOut,
    hub: tuple[str, str] | None,
) -> list[GeoPoint]:
    origin = _origin_point(db, ctx, gazetteer)
    if origin is None or placement.location is None:
        return []
    points = [GeoPoint(latitude=origin[0], longitude=origin[1])]
    if hub:
        port = gazetteer.ports.get((hub[0].lower(), hub[1]))
        if port is None:
            return []
        points.append(GeoPoint(latitude=port.latitude, longitude=port.longitude))
    return [*points, placement.location]


def compare_order_markets(
    db: Session, ctx: CompanyContext, order_id: str, market_code: str
) -> MarketComparisonOut:
    target = map_queries.get_market(db, market_code.strip().upper())
    if not target:
        raise AppError(
            422, "unknown_market", f"Unknown market: {market_code}.", {"market": "Unknown market"}
        )
    order = _load_order(db, ctx, order_id)
    gazetteer = load_gazetteer(db)
    placement = locate_destination(order.destination, gazetteer)
    if placement.market == target.code:
        raise AppError(
            422,
            "same_market",
            f"{order.external_id} already ships to {target.name}.",
            {"market": "Pick a different market"},
        )
    docs = _supplier_documents(db, ctx, order)
    requirements = requirements_by_market(db, ctx.company_id)
    result = compare_requirements(
        order,
        gazetteer.markets.get(placement.market) if placement.market else None,
        requirements.get(placement.market, []) if placement.market else [],
        target,
        requirements.get(target.code, []),
        docs,
    )
    _log_comparison(ctx, order, result, docs is not None)
    return result
