import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.database.models import RequirementLevel, RequirementStatus
from app.schemas.common import CamelCaseModel


class MarketRequirementOut(CamelCaseModel):
    id: uuid.UUID
    market_code: str
    requirement_key: str
    title: str
    level: RequirementLevel
    document_kind: str | None
    accepted_standards: list[str]
    form: str | None
    hs_prefixes: list[str]
    why: str
    source_quote: str
    # False: the quote wasn't found in the document's text (or it has none: a scanned PDF);
    # check it against the file before approving.
    quote_verified: bool
    effective_on: date | None
    duty_rate_percent: float | None
    status: RequirementStatus
    shared: bool  # from an official text, checked for every company
    regulation_document_id: uuid.UUID
    reviewed_at: datetime | None


class RequirementChangeOut(CamelCaseModel):
    """How one requirement differs from the previous version of the regulation."""

    market_code: str
    requirement_key: str
    title: str
    change: Literal["added", "changed", "removed"]
    fields: list[str]  # for "changed": which fields differ, e.g. ["hsPrefixes"]


class VersionRequirementsOut(CamelCaseModel):
    regulation_id: uuid.UUID
    document_id: uuid.UUID
    version_number: int
    previous_version_number: int | None
    # Checked against orders: every requirement reviewed or rejected, at least one reviewed.
    in_force: bool
    requirements: list[MarketRequirementOut]
    changes: list[RequirementChangeOut]


class DraftedRequirementsOut(VersionRequirementsOut):
    """The drafts, and how the document was read."""

    read_as: Literal["text", "scanned_file"]  # scanned: AI read the file; quotes unchecked
    sections_selected: bool  # a long text was cut down to its closest sections
    dropped: dict[str, int]  # drafts code dropped, by reason (e.g. "quote_not_in_document")


class MarketRequirementUpdate(CamelCaseModel):
    """The reviewer's edits to a draft, and their decision."""

    market_code: str | None = Field(default=None, min_length=2, max_length=8)
    title: str | None = Field(default=None, min_length=1, max_length=150)
    level: RequirementLevel | None = None
    document_kind: str | None = Field(default=None, max_length=40)
    accepted_standards: list[str] | None = Field(default=None, max_length=20)
    form: str | None = Field(default=None, max_length=1000)
    hs_prefixes: list[str] | None = Field(default=None, max_length=50)
    why: str | None = Field(default=None, min_length=1, max_length=2000)
    source_quote: str | None = Field(default=None, min_length=1, max_length=5000)
    effective_on: date | None = None
    duty_rate_percent: float | None = Field(default=None, ge=0, le=1000)
    status: Literal["reviewed", "rejected"] | None = None


class ExtractedRequirement(BaseModel):
    """One requirement as the extraction agent returns it (checked in code before saving)."""

    market_code: str
    requirement_key: str
    title: str
    level: str
    document_kind: str | None
    hs_prefixes: list[str]
    why: str
    source_quote: str
    effective_on: str | None  # YYYY-MM-DD, when the text says it starts later
    duty_rate_percent: float | None


class ExtractedRequirements(BaseModel):
    requirements: list[ExtractedRequirement]
