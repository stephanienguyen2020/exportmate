import uuid
from dataclasses import dataclass

from app.database.models import Company, Role, User


@dataclass(frozen=True)
class TokenClaims:
    """Identity from the sign-in token."""

    uid: str
    email: str
    email_verified: bool
    name: str


@dataclass(frozen=True)
class CompanyContext:
    """An authenticated user acting inside their company."""

    user: User
    company: Company
    role: Role

    @property
    def company_id(self) -> uuid.UUID:
        return self.company.id
