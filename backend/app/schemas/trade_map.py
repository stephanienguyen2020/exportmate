import uuid
from datetime import date
from typing import Literal

from pydantic import Field

from app.database.models import ObservationConfidence, RequirementLevel, SiteKind
from app.schemas.common import CamelCaseModel
from app.schemas.orders import OrderOut

CheckStatus = Literal["on_file", "missing", "mismatch", "prepare", "check", "unknown"]


class GeoPoint(CamelCaseModel):
    latitude: float
    longitude: float


class MarketOut(CamelCaseModel):
    code: str
    name: str
    short_name: str
    hub: GeoPoint
    country_ids: list[str]  # ISO 3166-1 numeric, matching world-atlas features
    search_terms: list[str]


class OrderPlacementOut(CamelCaseModel):
    city: str
    country: str | None  # ISO alpha-2 as written, or from the port list
    market: str | None  # None: the country isn't in a market on the map
    location: GeoPoint | None
    approximate: bool  # placed at the country centre, not a known port


class RequirementSourceOut(CamelCaseModel):
    """The regulation document (one version of a shared official text) that sets a market
    requirement, and the sentence in it that says so."""

    regulation_id: uuid.UUID
    regulation_title: str
    official_id: str | None
    document_id: uuid.UUID  # GET /regulation-documents/{id}/file downloads it
    document_title: str
    version_number: int
    source_url: str | None
    quote: str


class RequirementCheckOut(CamelCaseModel):
    requirement_key: str
    title: str
    level: RequirementLevel
    status: CheckStatus
    note: str
    source: RequirementSourceOut


class MapOrderOut(CamelCaseModel):
    order: OrderOut
    placement: OrderPlacementOut
    checks: list[RequirementCheckOut]
    gap_count: int  # checks that are "missing" or "mismatch"


class DocumentKindOut(CamelCaseModel):
    kind: str
    label: str


class SupplierDocumentOut(CamelCaseModel):
    kind: str
    label: str
    detail: str
    standards: list[str]


class MapSupplierOut(CamelCaseModel):
    id: uuid.UUID | None  # None: named on orders but not in the supplier list
    name: str
    place: str | None
    location: GeoPoint | None
    supplies: str | None
    documents: list[SupplierDocumentOut] | None  # None: no supplier record to check against
    order_ids: list[str]


class SiteOut(CamelCaseModel):
    key: str
    kind: SiteKind
    name: str
    short_name: str
    place: str
    location: GeoPoint
    note: str
    is_route_origin: bool


class NearbyPlaceOut(CamelCaseModel):
    type: Literal["supplier", "site"]
    ref: str  # supplier name or site key
    name: str
    distance_km: int  # from the edge of the observed extent; 0 = inside it


class SatelliteObservationOut(CamelCaseModel):
    id: uuid.UUID
    kind: str
    title: str
    place: str
    center: GeoPoint
    radius_km: float
    area_km2: float
    observed_on: date
    sensor: str
    confidence: ObservationConfidence
    confidence_note: str
    extent: dict  # GeoJSON Polygon
    is_sample: bool
    source_url: str | None
    nearby: list[NearbyPlaceOut]


class TradeMapOut(CamelCaseModel):
    markets: list[MarketOut]
    orders: list[MapOrderOut]
    suppliers: list[MapSupplierOut]
    sites: list[SiteOut]
    observations: list[SatelliteObservationOut]
    document_kinds: list[DocumentKindOut]
    home_country_ids: list[str]  # countries with the company's sites or suppliers
    check_radius_km: float


class ComparisonItemOut(CamelCaseModel):
    title: str
    note: str
    tag: Literal["New", "Changes", "Prepare"] | None = None


class MarketComparisonOut(CamelCaseModel):
    order_id: str
    kind: Literal["market", "ship_date", "route"] = "market"
    from_market: str | None
    to_market: str
    from_ship_date: date | None = None
    to_ship_date: date | None = None
    via: str | None = None
    via_name: str | None = None
    # Great-circle kilometres for a route. Not a voyage and not a freight quote.
    distance_km: int | None = None
    # Ordered origin, optional stop, destination. Empty when either endpoint is unknown.
    route_points: list[GeoPoint] = Field(default_factory=list)
    reuse: list[ComparisonItemOut]
    reevaluate: list[ComparisonItemOut]
    unknown: list[ComparisonItemOut]
    dropped: list[str]
    assumptions: list[str] = Field(default_factory=list)
