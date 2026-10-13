import re
import uuid
from datetime import UTC, datetime
from typing import Annotated, Literal

from pydantic import Field, StringConstraints, field_validator, model_validator

from app.core.currencies import is_currency
from app.database.models import Role, SiteKind
from app.schemas.common import CamelCaseModel

BusinessRole = Literal["Manufacturer", "Buyer / trader"]
TeamSize = Literal["1-10", "11-50", "51-200", "201-500", "500+"]
WEBSITE_PATTERN = r"^https?://[^\s/$.?#][^\s]*$"
TransitStop = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
MAX_TRANSIT_STOPS = 3


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
    transit: list[str]
    destination: str
    currency: str
    description: str
    products: str
    materials: str
    certifications: str
    website: str | None
    founded_year: int | None
    team_size: str | None
    updated_at: datetime


class AccountOut(CamelCaseModel):
    user: UserOut
    company: CompanyOut | None
    role: Role | None
    onboarded: bool


class UserUpdate(CamelCaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    alerts: bool | None = None
    digest: bool | None = None


def _not_blank(value: str | None) -> str | None:
    if value is not None and not value.strip():
        raise ValueError("Must not be blank")
    return value.strip() if value is not None else None


class OnboardingIn(CamelCaseModel):
    company_name: str = Field(min_length=1, max_length=200)
    business_role: BusinessRole
    origin: str = Field(min_length=1, max_length=100)
    # Stops between origin and destination, in order. Empty means the route is direct.
    transit: list[TransitStop] = Field(default_factory=list, max_length=MAX_TRANSIT_STOPS)
    destination: str = Field(min_length=1, max_length=100)
    currency: str = Field(default="USD", pattern=r"^[A-Z]{3}$")
    # What the company does, in its own words. The AI assistant answers from it.
    description: str = Field(min_length=1, max_length=2000)

    _description_not_blank = field_validator("description")(_not_blank)

    @field_validator("currency")
    @classmethod
    def _known_currency(cls, value: str) -> str:
        if not is_currency(value):
            raise ValueError("Use an ISO currency code like USD.")
        return value


class CompanyUpdate(CamelCaseModel):
    """Only the fields sent are changed. Optional fields are cleared with null (or "")."""

    name: str | None = Field(default=None, min_length=1, max_length=200)
    business_role: BusinessRole | None = None
    origin: str | None = Field(default=None, min_length=1, max_length=100)
    # Replaces all stops; [] makes the route direct.
    transit: list[TransitStop] | None = Field(default=None, max_length=MAX_TRANSIT_STOPS)
    destination: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, min_length=1, max_length=2000)
    products: str | None = Field(default=None, max_length=1000)
    materials: str | None = Field(default=None, max_length=1000)
    certifications: str | None = Field(default=None, max_length=1000)
    website: str | None = Field(default=None, max_length=300)
    founded_year: int | None = Field(default=None, ge=1800)
    team_size: TeamSize | None = None

    _description_not_blank = field_validator("description")(_not_blank)

    @field_validator("website")
    @classmethod
    def website_is_a_web_address(cls, value: str | None) -> str | None:
        value = (value or "").strip()
        if not value:
            return None
        if not value.startswith(("http://", "https://")):
            value = "https://" + value
        if not re.match(WEBSITE_PATTERN, value):
            raise ValueError("Enter a web address, e.g. https://example.com")
        return value

    @field_validator("founded_year")
    @classmethod
    def founded_year_not_in_future(cls, value: int | None) -> int | None:
        if value is not None and value > datetime.now(UTC).year:
            raise ValueError("Year can't be in the future")
        return value

    @model_validator(mode="after")
    def required_fields_stay_set(self):
        for field in ("name", "business_role", "origin", "transit", "destination", "description"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} can't be cleared")
        return self


class CompanySiteOut(CamelCaseModel):
    name: str
    kind: SiteKind
    place: str


class CompanyKnowledgeOut(CamelCaseModel):
    """What the AI assistant may know about the caller's company."""

    company: CompanyOut
    sites: list[CompanySiteOut]
