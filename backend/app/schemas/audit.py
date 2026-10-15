import uuid
from datetime import datetime
from typing import Any

from pydantic import Field, field_validator

from app.schemas.common import CamelCaseModel, is_email_address


class AuditUserOut(CamelCaseModel):
    id: uuid.UUID
    name: str
    email: str


class AuditEventOut(CamelCaseModel):
    id: uuid.UUID
    action: str  # e.g. "import.committed", "supplier_message.sent"
    object_type: str
    object_id: str
    data: dict[str, Any]
    user: AuditUserOut | None  # None: done by the system (the seed)
    request_id: str | None
    created_at: datetime


class ContactIn(CamelCaseModel):
    """The public contact form. `website` is a hidden field people never fill in: bots do."""

    name: str = Field(min_length=1, max_length=200)
    email: str = Field(max_length=254)
    company: str | None = Field(default=None, max_length=200)
    message: str = Field(min_length=1, max_length=5000)
    website: str = Field(default="", max_length=500)

    @field_validator("name", "message")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Can't be empty")
        return value.strip()

    @field_validator("email")
    @classmethod
    def valid_email(cls, value: str) -> str:
        value = value.strip()
        if not is_email_address(value):
            raise ValueError("Not an email address")
        return value
