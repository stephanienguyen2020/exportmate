import uuid
from datetime import datetime

from pydantic import Field, field_validator

from app.database.models import Role
from app.schemas.common import CamelCaseModel, is_email_address


class PersonOut(CamelCaseModel):
    id: uuid.UUID
    name: str


class MemberOut(CamelCaseModel):
    user_id: uuid.UUID
    name: str
    email: str
    role: Role
    joined_at: datetime
    you: bool


class MemberRoleIn(CamelCaseModel):
    role: Role


class InviteIn(CamelCaseModel):
    email: str = Field(min_length=3, max_length=254)
    role: Role

    @field_validator("email")
    @classmethod
    def _one_address(cls, value: str) -> str:
        value = value.strip().lower()
        if not is_email_address(value):
            raise ValueError("Enter one email address, e.g. name@example.com")
        return value


class InviteOut(CamelCaseModel):
    id: uuid.UUID
    email: str
    role: Role
    invited_by: PersonOut | None
    created_at: datetime
    expires_at: datetime
    expired: bool


class InviteSentOut(InviteOut):
    # True when no email went out (no RESEND_API_KEY): the owner has to pass the word on.
    sandbox: bool


class ReceivedInviteOut(CamelCaseModel):
    """An invitation to the caller's own email address."""

    id: uuid.UUID
    company_name: str
    role: Role
    invited_by: PersonOut | None
    expires_at: datetime
