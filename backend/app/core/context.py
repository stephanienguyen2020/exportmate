import uuid
from dataclasses import dataclass

from app.core.errors import AppError
from app.database.models import Company, Role, User


@dataclass(frozen=True)
class TokenClaims:
    """Identity from the sign-in token."""

    uid: str
    email: str
    email_verified: bool
    name: str
    # Firebase anonymous sign-in: a demo visitor, who may only use a demo sandbox.
    anonymous: bool = False


@dataclass(frozen=True)
class CompanyContext:
    """An authenticated user acting inside their company."""

    user: User
    company: Company
    role: Role

    @property
    def company_id(self) -> uuid.UUID:
        return self.company.id

    @property
    def is_demo(self) -> bool:
        return self.company.demo_expires_at is not None


def refuse_in_demo(ctx: CompanyContext, action: str) -> None:
    """Anyone can open a demo sandbox, so it sends no email to anyone."""
    if ctx.is_demo:
        raise AppError(
            403, "demo_no_email", f"The demo doesn't send email. Create an account to {action}."
        )
