"""Trade map tables.

Shared reference data (every company reads the same rows): markets, countries, ports,
document kinds, per-market requirement checklists and satellite observations.
Company data (scoped by company_id): suppliers, their documents, and the company's own sites.
Orders keep `supplier` as text from the CSV; it is matched to `suppliers.name_key`.
"""

import enum
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database.models.base import Base, created_column, id_column, pg_enum


class RequirementLevel(str, enum.Enum):
    supplier = "supplier"  # evidence a supplier provides once; reusable across orders
    shipment = "shipment"  # prepared for each shipment
    check = "check"  # something to recheck (e.g. a tariff category), not a document


class SupplierDocumentUploadStatus(str, enum.Enum):
    draft = "draft"  # read by AI, waiting for a person to confirm the fields
    confirmed = "confirmed"


class SiteKind(str, enum.Enum):
    factory = "factory"
    port = "port"
    warehouse = "warehouse"


class ObservationKind(str, enum.Enum):
    flood = "flood"


class ObservationConfidence(str, enum.Enum):
    high = "high"
    low = "low"


class Market(Base):
    __tablename__ = "markets"
    code: Mapped[str] = mapped_column(String(8), primary_key=True)  # "EU", "US"
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    short_name: Mapped[str] = mapped_column(String(40), nullable=False)
    hub_latitude: Mapped[float] = mapped_column(Float, nullable=False)
    hub_longitude: Mapped[float] = mapped_column(Float, nullable=False)
    # Words that tie a news item to this market, e.g. "EUDR". Matched case-sensitively.
    search_terms: Mapped[list[str]] = mapped_column(ARRAY(String(60)), nullable=False, default=list)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class Country(Base):
    __tablename__ = "countries"
    alpha2: Mapped[str] = mapped_column(String(2), primary_key=True)
    numeric_code: Mapped[str] = mapped_column(String(3), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    market_code: Mapped[str | None] = mapped_column(ForeignKey("markets.code"))
    # Where a destination goes when its city isn't a known port.
    center_latitude: Mapped[float | None] = mapped_column(Float)
    center_longitude: Mapped[float | None] = mapped_column(Float)


class Port(Base):
    __tablename__ = "ports"
    id: Mapped[uuid.UUID] = id_column()
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    name_key: Mapped[str] = mapped_column(String(100), nullable=False)  # lower-case name
    country_alpha2: Mapped[str] = mapped_column(ForeignKey("countries.alpha2"), nullable=False)
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    __table_args__ = (UniqueConstraint("name_key", "country_alpha2"),)


class DocumentKind(Base):
    __tablename__ = "document_kinds"
    kind: Mapped[str] = mapped_column(String(40), primary_key=True)  # "geolocation"
    label: Mapped[str] = mapped_column(String(100), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class MarketRequirement(Base):
    """One line of a market's checklist. The same key in two markets is the same kind of
    requirement, which is how a comparison knows what carries over.

    Each market requirement cites the regulation document (one version of an official text)
    that sets it, and the sentence in that document that says so (`source_quote`).
    """

    __tablename__ = "market_requirements"
    id: Mapped[uuid.UUID] = id_column()
    market_code: Mapped[str] = mapped_column(
        ForeignKey("markets.code", ondelete="CASCADE"), index=True, nullable=False
    )
    requirement_key: Mapped[str] = mapped_column(String(40), nullable=False)
    title: Mapped[str] = mapped_column(String(150), nullable=False)
    level: Mapped[RequirementLevel] = mapped_column(
        pg_enum(RequirementLevel, "requirement_level"), nullable=False
    )
    document_kind: Mapped[str | None] = mapped_column(ForeignKey("document_kinds.kind"))
    # Test standards this market accepts, e.g. ["TSCA Title VI"]. Empty: any record counts.
    accepted_standards: Mapped[list[str]] = mapped_column(
        ARRAY(String(100)), nullable=False, default=list
    )
    form: Mapped[str | None] = mapped_column(Text)  # what to prepare, for shipment documents
    # HS code prefixes it applies to, digits only. Empty: every product.
    hs_prefixes: Mapped[list[str]] = mapped_column(ARRAY(String(12)), nullable=False, default=list)
    why: Mapped[str] = mapped_column(Text, nullable=False)
    # The ship date must be on or after this day for the line to apply. Empty: already in force.
    effective_on: Mapped[date | None] = mapped_column(Date)
    # A stated change (a rate or a threshold), not the day the line starts.
    changes_on: Mapped[date | None] = mapped_column(Date)
    change_note: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    # Origin proofs and other lines whose answer can change if the goods transship.
    route_sensitive: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    regulation_document_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("regulation_documents.id"), index=True, nullable=False
    )
    source_quote: Mapped[str] = mapped_column(Text, nullable=False)
    # A duty the text sets as a share of the order value, e.g. 25 for "25 percent ad valorem".
    duty_rate_percent: Mapped[Decimal | None] = mapped_column(Numeric(6, 2))
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    __table_args__ = (UniqueConstraint("market_code", "requirement_key"),)


class Supplier(Base):
    __tablename__ = "suppliers"
    id: Mapped[uuid.UUID] = id_column()
    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(300), nullable=False)
    # Lower-case, trimmed name; orders match on it.
    name_key: Mapped[str] = mapped_column(String(300), nullable=False)
    place: Mapped[str | None] = mapped_column(String(200))
    country_alpha2: Mapped[str | None] = mapped_column(ForeignKey("countries.alpha2"))
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    supplies: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_column()
    __table_args__ = (UniqueConstraint("company_id", "name_key"),)


class SupplierDocument(Base):
    """A document a supplier holds, one per kind. Seeded, or confirmed from an upload."""

    __tablename__ = "supplier_documents"
    id: Mapped[uuid.UUID] = id_column()
    supplier_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("suppliers.id", ondelete="CASCADE"), index=True, nullable=False
    )
    kind: Mapped[str] = mapped_column(ForeignKey("document_kinds.kind"), nullable=False)
    detail: Mapped[str] = mapped_column(Text, nullable=False)
    standards: Mapped[list[str]] = mapped_column(ARRAY(String(100)), nullable=False, default=list)
    document_number: Mapped[str | None] = mapped_column(String(100))
    issuer: Mapped[str | None] = mapped_column(String(200))
    expires_on: Mapped[date | None] = mapped_column(Date)
    # The upload it was confirmed from; null for seeded records.
    upload_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("supplier_document_uploads.id"))
    created_at: Mapped[datetime] = created_column()
    __table_args__ = (UniqueConstraint("supplier_id", "kind"),)


class SupplierDocumentUpload(Base):
    """A certificate file a company uploaded for a supplier, and the fields AI read from it.

    The file is in Cloud Storage. Nothing is checked against it until a person confirms the
    fields, which writes the supplier document."""

    __tablename__ = "supplier_document_uploads"
    id: Mapped[uuid.UUID] = id_column()
    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), index=True, nullable=False
    )
    supplier_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("suppliers.id", ondelete="CASCADE"), index=True, nullable=False
    )
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    storage_path: Mapped[str] = mapped_column(String(500), nullable=False)
    extracted: Mapped[dict] = mapped_column(JSONB, nullable=False)  # what AI read
    status: Mapped[SupplierDocumentUploadStatus] = mapped_column(
        pg_enum(SupplierDocumentUploadStatus, "supplier_document_upload_status"),
        nullable=False,
        default=SupplierDocumentUploadStatus.draft,
    )
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = created_column()
    confirmed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CostDefault(Base):
    """A cost assumption shared by every company, e.g. delay USD 200 a day. Seeded."""

    __tablename__ = "cost_defaults"
    key: Mapped[str] = mapped_column(String(40), primary_key=True)  # "delay_per_day"
    label: Mapped[str] = mapped_column(String(150), nullable=False)
    # "days", or an ISO 4217 currency; money values are hundredths of the unit, like orders.
    unit: Mapped[str] = mapped_column(String(4), nullable=False)
    value: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class CompanyCostSetting(Base):
    """A company's own value for a cost assumption; replaces the shared default."""

    __tablename__ = "company_cost_settings"
    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), primary_key=True
    )
    key: Mapped[str] = mapped_column(ForeignKey("cost_defaults.key"), primary_key=True)
    unit: Mapped[str] = mapped_column(String(4), nullable=False)
    value: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    updated_at: Mapped[datetime] = created_column()


class CompanySite(Base):
    __tablename__ = "company_sites"
    id: Mapped[uuid.UUID] = id_column()
    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), index=True, nullable=False
    )
    site_key: Mapped[str] = mapped_column(String(50), nullable=False)
    kind: Mapped[SiteKind] = mapped_column(pg_enum(SiteKind, "site_kind"), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    short_name: Mapped[str] = mapped_column(String(60), nullable=False)
    place: Mapped[str] = mapped_column(String(200), nullable=False)
    country_alpha2: Mapped[str | None] = mapped_column(ForeignKey("countries.alpha2"))
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # Where order routes start on the world map.
    is_route_origin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = created_column()
    __table_args__ = (UniqueConstraint("company_id", "site_key"),)


class SatelliteObservation(Base):
    __tablename__ = "satellite_observations"
    id: Mapped[uuid.UUID] = id_column()
    # Stable id from the source (or "sample:<name>"), so reloading updates instead of duplicating.
    source_ref: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    kind: Mapped[ObservationKind] = mapped_column(
        pg_enum(ObservationKind, "observation_kind"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    place: Mapped[str] = mapped_column(String(200), nullable=False)
    center_latitude: Mapped[float] = mapped_column(Float, nullable=False)
    center_longitude: Mapped[float] = mapped_column(Float, nullable=False)
    radius_km: Mapped[float] = mapped_column(Float, nullable=False)
    area_km2: Mapped[float] = mapped_column(Float, nullable=False)
    observed_on: Mapped[date] = mapped_column(Date, nullable=False)
    sensor: Mapped[str] = mapped_column(String(100), nullable=False)
    confidence: Mapped[ObservationConfidence] = mapped_column(
        pg_enum(ObservationConfidence, "observation_confidence"), nullable=False
    )
    confidence_note: Mapped[str] = mapped_column(Text, nullable=False)
    extent: Mapped[dict] = mapped_column(JSONB, nullable=False)  # GeoJSON Polygon
    is_sample: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    source_url: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_column()
