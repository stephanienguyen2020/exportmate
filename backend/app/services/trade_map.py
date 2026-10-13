"""Trade map: where a company's orders, suppliers and sites are, which documents each order
still needs in its market, and what changes if an order went to another market.

Geography and market checklists are shared reference tables; suppliers, their documents and
sites belong to one company. Checklists are illustrative until obligations come from reviewed
regulation documents (REQUIREMENTS.md §4.5). Observations marked sample are not a live feed.
"""

import logging
import math
import re
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.context import CompanyContext
from app.core.errors import AppError, not_found_error
from app.database.models import (
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


def _check_requirement(
    requirement: MarketRequirement, supplier: str, documents: SupplierDocs | None
) -> tuple[CheckStatus, str]:
    if requirement.level == RequirementLevel.shipment:
        return "prepare", requirement.form or requirement.why
    if requirement.level == RequirementLevel.check:
        return "check", requirement.why
    if documents is None:
        return "unknown", "No document record for this supplier."
    record = documents.get(requirement.document_kind) if requirement.document_kind else None
    if record is None:
        return "missing", f"Not on file from {supplier}."
    accepted = requirement.accepted_standards
    if accepted and not set(record.standards) & set(accepted):
        on_file = ", ".join(record.standards) or "untested"
        return "mismatch", f"On file: {on_file}. Expected: {' or '.join(accepted)}."
    return "on_file", record.detail


def _evaluate(
    order: Order, requirements: list[MarketRequirement], documents: SupplierDocs | None
) -> list[tuple[MarketRequirement, CheckStatus, str]]:
    return [
        (req, *_check_requirement(req, order.supplier, documents))
        for req in requirements
        if applies_to(req, order.hs_code)
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
    before = {r.requirement_key: r for r in from_requirements if applies_to(r, order.hs_code)}
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
                        f"Already used for {current}."
                        if prior
                        else f"On file, though {current or 'the current market'} doesn't ask for it."
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
                reuse.append(
                    ComparisonItemOut(
                        title=req.title, note="Same requirement; no change for this market."
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
    if len(to_requirements) <= 2:
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
    return EARTH_RADIUS_KM * 2 * math.asin(math.sqrt(a))


def km_from_extent(observation: SatelliteObservation, latitude: float, longitude: float) -> int:
    """Distance to the edge of the observed extent; 0 means inside it."""
    centre = distance_km(
        observation.center_latitude, observation.center_longitude, latitude, longitude
    )
    return max(0, round(centre - observation.radius_km))


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
            nearby.append(NearbyPlaceOut(type=kind, ref=ref, name=name, distance_km=km))
    return sorted(nearby, key=lambda p: (p.distance_km, p.name))


def _load_gazetteer(db: Session) -> Gazetteer:
    return Gazetteer.from_rows(
        map_queries.list_markets(db), map_queries.list_countries(db), map_queries.list_ports(db)
    )


def _requirements_by_market(db: Session) -> dict[str, list[MarketRequirement]]:
    grouped: dict[str, list[MarketRequirement]] = defaultdict(list)
    for req in map_queries.list_market_requirements(db):
        grouped[req.market_code].append(req)
    return grouped


def _requirement_sources(
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


def _documents_by_supplier(db: Session, suppliers: list[Supplier]) -> dict[uuid.UUID, SupplierDocs]:
    grouped: dict[uuid.UUID, SupplierDocs] = {s.id: {} for s in suppliers}
    for doc in map_queries.list_supplier_documents(db, grouped):
        grouped[doc.supplier_id][doc.kind] = doc
    return grouped


def _point(latitude: float | None, longitude: float | None) -> GeoPoint | None:
    if latitude is None or longitude is None:
        return None
    return GeoPoint(latitude=latitude, longitude=longitude)


def build_trade_map(db: Session, ctx: CompanyContext) -> TradeMapOut:
    started = time.perf_counter()
    radius = get_settings().flood_check_radius_km
    gazetteer = _load_gazetteer(db)
    requirements = _requirements_by_market(db)
    sources = _requirement_sources(db, requirements)
    kinds = {k.kind: k.label for k in map_queries.list_document_kinds(db)}
    orders = order_queries.list_company_orders(db, ctx.company_id)
    suppliers = map_queries.list_company_suppliers(db, ctx.company_id)
    by_key = {s.name_key: s for s in suppliers}
    documents = _documents_by_supplier(db, suppliers)
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
            location=_point(s.latitude, s.longitude),
            supplies=s.supplies,
            documents=[
                SupplierDocumentOut(
                    kind=d.kind,
                    label=kinds.get(d.kind, d.kind),
                    detail=d.detail,
                    standards=d.standards,
                )
                for d in documents[s.id].values()
            ],
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
        sites=[
            SiteOut(
                key=s.site_key,
                kind=s.kind,
                name=s.name,
                short_name=s.short_name,
                place=s.place,
                location=GeoPoint(latitude=s.latitude, longitude=s.longitude),
                note=s.note,
                is_route_origin=s.is_route_origin,
            )
            for s in sites
        ],
        observations=map_observations,
        document_kinds=[DocumentKindOut(kind=k, label=label) for k, label in kinds.items()],
        home_country_ids=sorted(
            gazetteer.countries[c].numeric_code for c in home if c in gazetteer.countries
        ),
        check_radius_km=radius,
    )


def compare_order_markets(
    db: Session, ctx: CompanyContext, order_id: str, market_code: str
) -> MarketComparisonOut:
    target = map_queries.get_market(db, market_code.strip().upper())
    if not target:
        raise AppError(
            422, "unknown_market", f"Unknown market: {market_code}.", {"market": "Unknown market"}
        )
    order = order_queries.get_order_by_external_id(db, ctx.company_id, order_id)
    if not order:
        raise not_found_error("Order")
    gazetteer = _load_gazetteer(db)
    placement = locate_destination(order.destination, gazetteer)
    if placement.market == target.code:
        raise AppError(
            422,
            "same_market",
            f"{order.external_id} already ships to {target.name}.",
            {"market": "Pick a different market"},
        )
    supplier = map_queries.get_supplier_by_name_key(
        db, ctx.company_id, supplier_name_key(order.supplier)
    )
    docs = _documents_by_supplier(db, [supplier])[supplier.id] if supplier else None
    requirements = _requirements_by_market(db)
    result = compare_requirements(
        order,
        gazetteer.markets.get(placement.market) if placement.market else None,
        requirements.get(placement.market, []) if placement.market else [],
        target,
        requirements.get(target.code, []),
        docs,
    )
    log.info(
        "trade_map.compared",
        extra={
            "company_id": str(ctx.company_id),
            "order_id": order.external_id,
            "from_market": result.from_market,
            "to_market": result.to_market,
            "reuse": len(result.reuse),
            "reevaluate": len(result.reevaluate),
            "unknown": len(result.unknown),
            "supplier_record": supplier is not None,
        },
    )
    return result
