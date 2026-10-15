import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from app.database.models import SupplierMessageStatus
from app.schemas.analysis import PersonOut
from app.schemas.common import CamelCaseModel, is_email_address


def _optional_recipient(value: str | None) -> str | None:
    value = (value or "").strip()
    if not value:
        return None
    if not is_email_address(value):
        raise ValueError("Not an email address")
    return value


class SupplierMessageDraftIn(CamelCaseModel):
    report_id: uuid.UUID
    # Default: the supplier's contact email, when the supplier record has one.
    recipient: str | None = Field(default=None, max_length=254)

    _recipient = field_validator("recipient")(_optional_recipient)


class SupplierMessageUpdate(CamelCaseModel):
    """Edits; any edit to an approved message sends it back to draft."""

    recipient: str | None = Field(default=None, max_length=254)
    subject: str | None = Field(default=None, min_length=1, max_length=200)
    body: str | None = Field(default=None, min_length=1, max_length=5000)
    # Also store the recipient as the supplier's contact email, for next time.
    save_recipient_to_supplier: bool = False

    _recipient = field_validator("recipient")(_optional_recipient)


class SupplierMessageOut(CamelCaseModel):
    id: uuid.UUID
    report_id: uuid.UUID
    order_id: str  # the company's order ID, e.g. "PO-2291"
    supplier_id: uuid.UUID | None
    status: SupplierMessageStatus
    recipient: str | None
    subject: str
    body: str
    created_by: PersonOut
    created_at: datetime
    approved_by: PersonOut | None
    approved_at: datetime | None
    approved_by_author: bool  # one person drafted and approved it (allowed; recorded)
    sent_at: datetime | None
    sandbox: bool | None  # True: sent in sandbox mode, nothing delivered
    error: str | None


class DraftedMessage(BaseModel):
    """The AI's draft (checked in code before saving)."""

    subject: str
    body: str
