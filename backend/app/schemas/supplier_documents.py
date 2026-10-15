import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field

from app.database.models import SupplierDocumentUploadStatus
from app.schemas.common import CamelCaseModel


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
