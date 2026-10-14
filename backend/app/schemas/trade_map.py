import uuid
from datetime import date
from typing import Annotated, Literal

from pydantic import Field, StringConstraints, field_validator, model_validator

from app.database.models import ObservationConfidence, RequirementLevel, SiteKind
from app.schemas.common import CamelCaseModel
from app.schemas.orders import OrderOut

CheckStatus = Literal["on_file", "missing", "mismatch", "prepare", "check", "unknown"]


class GeoPoint(CamelCaseModel):
    latitude: float
    longitude: float


class GeoPointIn(CamelCaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class CountryOut(CamelCaseModel):
    code: str  # ISO 3166-1 alpha-2
    numeric_code: str  # matches world-atlas feature ids
    name: str


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
    country: str | None
    location: GeoPoint | None
    supplies: str | None
    documents: list[SupplierDocumentOut] | None  # None: no supplier record to check against
    order_ids: list[str]


class SiteOut(CamelCaseModel):
    id: uuid.UUID
    key: str
    kind: SiteKind
    name: str
    short_name: str
    place: str
    country: str | None
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
    countries: list[CountryOut]  # the countries a supplier or site can be in
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


# --- Entering suppliers and sites (editors)

ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
CountryCode = Annotated[str, StringConstraints(strip_whitespace=True, pattern=r"^[A-Za-z]{2}$")]
Standard = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
MAX_SUPPLIER_DOCUMENTS = 20
MAX_STANDARDS = 10


def _optional_text(value: str | None) -> str | None:
    """Blank optional text is stored as null."""
    if value is None:
        return None
    return value.strip() or None


def _country_code(value: str | None) -> str | None:
    # ISO reserves "UK" for the United Kingdom, whose code is GB; people write both.
    if value is None:
        return None
    code = value.upper()
    return "GB" if code == "UK" else code


def _keep_required(model: CamelCaseModel, fields: tuple[str, ...]) -> None:
    for field in fields:
        if field in model.model_fields_set and getattr(model, field) is None:
            raise ValueError(f"{field} can't be cleared")


class SupplierDocumentIn(CamelCaseModel):
    kind: str = Field(min_length=1, max_length=40)
    detail: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    standards: list[Standard] = Field(default_factory=list, max_length=MAX_STANDARDS)


def _one_document_per_kind(documents: list[SupplierDocumentIn] | None):
    if documents is not None:
        kinds = [d.kind for d in documents]
        if len(kinds) != len(set(kinds)):
            raise ValueError("One document per kind")
    return documents


class SupplierIn(CamelCaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
    place: str | None = Field(default=None, max_length=200)
    country: CountryCode | None = None
    location: GeoPointIn | None = None
    supplies: str | None = Field(default=None, max_length=1000)
    documents: list[SupplierDocumentIn] = Field(
        default_factory=list, max_length=MAX_SUPPLIER_DOCUMENTS
    )

    _optional = field_validator("place", "supplies")(_optional_text)
    _country = field_validator("country")(_country_code)
    _documents = field_validator("documents")(_one_document_per_kind)


class SupplierUpdate(CamelCaseModel):
    """Changes only the fields sent. `documents` replaces the whole list."""

    name: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
        | None
    ) = None
    place: str | None = Field(default=None, max_length=200)
    country: CountryCode | None = None
    location: GeoPointIn | None = None
    supplies: str | None = Field(default=None, max_length=1000)
    documents: list[SupplierDocumentIn] | None = Field(
        default=None, max_length=MAX_SUPPLIER_DOCUMENTS
    )

    _optional = field_validator("place", "supplies")(_optional_text)
    _country = field_validator("country")(_country_code)
    _documents = field_validator("documents")(_one_document_per_kind)

    @model_validator(mode="after")
    def required_fields_stay_set(self):
        _keep_required(self, ("name", "documents"))
        return self


class SupplierOut(CamelCaseModel):
    id: uuid.UUID
    name: str
    place: str | None
    country: str | None
    location: GeoPoint | None
    supplies: str | None
    documents: list[SupplierDocumentOut]


class SiteIn(CamelCaseModel):
    kind: SiteKind
    name: ShortText
    # Shown next to the marker. Defaults to the name.
    short_name: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)] | None
    ) = None
    place: ShortText
    country: CountryCode | None = None
    location: GeoPointIn
    note: str = Field(default="", max_length=1000)
    # Order routes start here. Setting it moves the start from any other site.
    is_route_origin: bool = False

    _country = field_validator("country")(_country_code)

    @field_validator("note")
    @classmethod
    def strip_note(cls, value: str) -> str:
        return value.strip()


class SiteUpdate(CamelCaseModel):
    """Changes only the fields sent."""

    kind: SiteKind | None = None
    name: ShortText | None = None
    short_name: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)] | None
    ) = None
    place: ShortText | None = None
    country: CountryCode | None = None
    location: GeoPointIn | None = None
    note: str | None = Field(default=None, max_length=1000)
    is_route_origin: bool | None = None

    _country = field_validator("country")(_country_code)

    @model_validator(mode="after")
    def required_fields_stay_set(self):
        _keep_required(
            self, ("kind", "name", "short_name", "place", "location", "note", "is_route_origin")
        )
        if self.note is not None:
            self.note = self.note.strip()
        return self
