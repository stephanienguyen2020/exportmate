import re
import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator

from app.database.models import ReportKind
from app.schemas.common import CamelCaseModel

MAX_REPORT_RECIPIENTS = 5
# One address, no display name: what a person types into a "To" field.
_EMAIL = re.compile(r"^[^@\s,;<>\"()]+@[^@\s,;<>\"()]+\.[A-Za-z]{2,}$")

CellText = Annotated[str, Field(max_length=4000)]
Tone = Literal["gap", "warn"]


class ReportRow(CamelCaseModel):
    id: str = Field(min_length=1, max_length=80)
    cells: list[CellText] = Field(max_length=8)
    tone: Tone | None = None  # gap: red, warn: amber, on the section's tone column
    included: bool = True


class ReportSection(CamelCaseModel):
    """One block of the report. `layout`, `widths` and `tone_column` are set when the report is
    generated and can't be changed; the rest is the author's to edit."""

    id: str = Field(min_length=1, max_length=40)
    layout: Literal["facts", "table", "sources"]
    heading: str = Field(max_length=200)
    note: str = Field(default="", max_length=4000)
    empty: str = Field(default="", max_length=500)  # shown when no row is included
    columns: list[Annotated[str, Field(max_length=60)]] = Field(min_length=1, max_length=8)
    widths: list[int] = Field(min_length=1, max_length=8)  # relative column widths
    tone_column: int | None = None
    rows: list[ReportRow] = Field(default_factory=list, max_length=500)
    included: bool = True

    @model_validator(mode="after")
    def rows_fit_columns(self):
        if len(self.widths) != len(self.columns):
            raise ValueError("widths and columns differ in length")
        for row in self.rows:
            if len(row.cells) != len(self.columns):
                raise ValueError(f"Row {row.id} needs {len(self.columns)} cells")
        if len({row.id for row in self.rows}) != len(self.rows):
            raise ValueError("Row ids must be unique")
        return self


class ReportContent(CamelCaseModel):
    title: str = Field(min_length=1, max_length=200)
    subtitle: str = Field(default="", max_length=300)
    summary: str = Field(default="", max_length=6000)
    sections: list[ReportSection] = Field(max_length=20)


class ReportCreateIn(CamelCaseModel):
    kind: ReportKind
    order_id: str | None = Field(default=None, min_length=1, max_length=100)
    # Company reports: events in the last `days` and changes in the next `days`.
    days: int = Field(default=30, ge=7, le=180)

    @model_validator(mode="after")
    def order_report_names_an_order(self):
        if self.kind == ReportKind.order and not self.order_id:
            raise ValueError("An order report needs orderId")
        return self


class ReportUpdateIn(CamelCaseModel):
    content: ReportContent


class ReportEditsOut(CamelCaseModel):
    """What the author changed from the generated report; the PDF marks the same things."""

    header: bool  # title, subtitle or summary
    sections: int  # headings, notes or column labels changed
    rows_edited: int
    rows_added: int
    rows_removed: int  # excluded rows and sections count here too

    @property
    def has_edits(self) -> bool:
        return bool(
            self.header or self.sections or self.rows_edited or self.rows_added or self.rows_removed
        )


class ReportDraftSummaryOut(CamelCaseModel):
    id: uuid.UUID
    kind: ReportKind
    title: str
    scope: dict
    created_at: datetime
    updated_at: datetime
    sent_at: datetime | None
    sent_to: list[str] | None


class ReportDraftOut(ReportDraftSummaryOut):
    company_name: str
    prepared_by: str
    content: ReportContent
    original: ReportContent
    edits: ReportEditsOut


class ReportEmailIn(CamelCaseModel):
    to: list[str] = Field(min_length=1, max_length=MAX_REPORT_RECIPIENTS)
    message: str | None = Field(default=None, max_length=1000)

    @field_validator("to")
    @classmethod
    def valid_addresses(cls, value: list[str]) -> list[str]:
        cleaned: list[str] = []
        for address in value:
            address = address.strip()
            if len(address) > 254 or not _EMAIL.match(address):
                raise ValueError(f"Not an email address: {address[:60]}")
            if address.lower() not in (a.lower() for a in cleaned):
                cleaned.append(address)
        return cleaned

    @field_validator("message")
    @classmethod
    def blank_message_is_none(cls, value: str | None) -> str | None:
        return value.strip() or None if value else None


class ReportEmailOut(CamelCaseModel):
    recipients: list[str]
    sandbox: bool  # True: nothing was delivered (no RESEND_API_KEY)
    sent_at: datetime
