import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field

from app.database.models import SupplierDocumentUploadStatus
from app.schemas.common import CamelCaseModel
from app.schemas.trade_map import SupplierSourcingIn


class SuggestedSourcing(CamelCaseModel):
    """A material the document says the goods are made of, matched to the knowledge graph:
    a suggestion for the supplier's sourcing until a person accepts it."""

    material: str  # material key, e.g. "acacia"
    material_name: str
    country: str | None  # where it comes from, when the document says
    form: str | None  # chain step, e.g. "roundwood"
    form_name: str | None
    read_as: str  # the words in the document, e.g. "Acacia mangium logs, Vietnam"


class ReadDocumentFields(CamelCaseModel):
    """What AI read from the file. Every field may be wrong until a person confirms it."""

    kind: str | None  # a document kind, or None when none fits
    document_number: str | None
    issuer: str | None
    issued_on: date | None
    expires_on: date | None
    standards: list[str]  # e.g. ["ISO 9001:2015"], ["GOTS 7.0"]
    detail: str  # one line, e.g. "ISO 9001 certificate QMS-001234, valid to 15 Dec 2026"
    notes: str | None  # what was hard to read
    # Materials it names that the knowledge graph knows (older uploads have none).
    sourcing: list[SuggestedSourcing] = Field(default_factory=list)


class SupplierDocumentUploadOut(CamelCaseModel):
    id: uuid.UUID
    supplier_id: uuid.UUID
    filename: str
    content_type: str
    size_bytes: int
    status: SupplierDocumentUploadStatus
    extracted: ReadDocumentFields
    created_at: datetime
    confirmed_at: datetime | None


class SupplierDocumentConfirmIn(CamelCaseModel):
    """The fields as the person checked them; these are what the checks use."""

    kind: str = Field(max_length=40)
    detail: str = Field(min_length=1, max_length=1000)
    standards: list[str] = Field(default_factory=list, max_length=20)
    document_number: str | None = Field(default=None, max_length=100)
    issuer: str | None = Field(default=None, max_length=200)
    expires_on: date | None = None
    # Suggested materials the person accepted: added to the supplier's sourcing.
    sourcing: list[SupplierSourcingIn] = Field(default_factory=list, max_length=20)


class ConfirmedSupplierDocumentOut(CamelCaseModel):
    id: uuid.UUID
    supplier_id: uuid.UUID
    kind: str
    detail: str
    standards: list[str]
    document_number: str | None
    issuer: str | None
    expires_on: date | None
    upload_id: uuid.UUID | None


class ReadMaterial(BaseModel):
    name: str  # as printed, e.g. "Acacia mangium"
    country: str | None  # ISO alpha-2 of where it comes from
    form: str | None  # e.g. "logs", "veneer", "sawn timber"


class ReadCertificate(BaseModel):
    """The AI's answer (checked in code before saving)."""

    kind: str | None
    document_number: str | None
    issuer: str | None
    issued_on: str | None  # YYYY-MM-DD
    expires_on: str | None  # YYYY-MM-DD
    standards: list[str]
    detail: str
    notes: str | None
    materials: list[ReadMaterial] = Field(default_factory=list)
