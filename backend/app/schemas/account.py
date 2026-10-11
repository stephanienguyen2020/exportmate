import uuid
from typing import Literal

from pydantic import Field

from app.database.models import Role
from app.schemas.common import CamelCaseModel

BusinessRole = Literal["Manufacturer", "Buyer / trader"]


class UserOut(CamelCaseModel):
    id: uuid.UUID
    email: str
    name: str
    alerts: bool
    digest: bool


class CompanyOut(CamelCaseModel):
    id: uuid.UUID
    name: str
    business_role: str
    origin: str
    destination: str
    currency: str


class AccountOut(CamelCaseModel):
    user: UserOut
    company: CompanyOut | None
    role: Role | None
    onboarded: bool


class UserUpdate(CamelCaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    alerts: bool | None = None
    digest: bool | None = None


class OnboardingIn(CamelCaseModel):
    company_name: str = Field(min_length=1, max_length=200)
    business_role: BusinessRole
    origin: str = Field(min_length=1, max_length=100)
    destination: str = Field(min_length=1, max_length=100)
    currency: str = Field(default="USD", pattern=r"^[A-Z]{3}$")


class CompanyUpdate(CamelCaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    business_role: BusinessRole | None = None
    origin: str | None = Field(default=None, min_length=1, max_length=100)
    destination: str | None = Field(default=None, min_length=1, max_length=100)
