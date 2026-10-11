"""Who is calling (Firebase token) and what they may touch (Postgres membership)."""

from typing import Annotated

import firebase_admin
from fastapi import Depends, Header
from firebase_admin import auth as fb_auth
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.context import CompanyContext, TokenClaims
from app.core.errors import AppError
from app.database.models import Role, User
from app.database.session import get_db
from app.services import accounts

_ROLE_RANK = {Role.viewer: 0, Role.editor: 1, Role.owner: 2}


def _verify_dev(token: str) -> TokenClaims:
    # "dev:lan@example.com" → verified user; "dev-unverified:..." → unverified.
    prefix, _, email = token.partition(":")
    if prefix not in ("dev", "dev-unverified") or "@" not in email:
        raise AppError(401, "unauthenticated", "Invalid dev token. Use 'dev:<email>'.")
    return TokenClaims(
        uid=f"dev:{email}",
        email=email,
        email_verified=prefix == "dev",
        name=email.split("@")[0],
    )


def _firebase_app() -> firebase_admin.App:
    if not firebase_admin._apps:
        return firebase_admin.initialize_app(
            options={"projectId": get_settings().firebase_project_id}
        )
    return firebase_admin.get_app()


def _verify_firebase(token: str) -> TokenClaims:
    try:
        decoded = fb_auth.verify_id_token(token, app=_firebase_app(), check_revoked=True)
    except fb_auth.RevokedIdTokenError:
        raise AppError(401, "session_revoked", "Session ended. Please sign in again.")
    except (ValueError, fb_auth.InvalidIdTokenError, fb_auth.ExpiredIdTokenError):
        raise AppError(401, "unauthenticated", "Invalid or expired sign-in token.")
    return TokenClaims(
        uid=decoded["uid"],
        email=decoded.get("email", ""),
        email_verified=bool(decoded.get("email_verified")),
        name=decoded.get("name", ""),
    )


def verify_token(token: str) -> TokenClaims:
    if get_settings().auth_mode == "dev":
        return _verify_dev(token)
    return _verify_firebase(token)


def revoke_sessions(uid: str) -> None:
    """Sign the user out on every device."""
    if get_settings().auth_mode == "dev":
        return
    fb_auth.revoke_refresh_tokens(uid, app=_firebase_app())


def current_claims(authorization: Annotated[str | None, Header()] = None) -> TokenClaims:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise AppError(401, "unauthenticated", "Sign in required.")
    claims = verify_token(token)
    if not claims.email_verified:
        raise AppError(403, "email_not_verified", "Verify your email address first.")
    return claims


def current_user(
    claims: Annotated[TokenClaims, Depends(current_claims)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    return accounts.get_or_create_user(db, uid=claims.uid, email=claims.email, name=claims.name)


def current_context(
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> CompanyContext:
    found = accounts.find_user_company_membership(db, user.id)
    if not found:
        raise AppError(403, "onboarding_required", "Finish onboarding to create your company.")
    membership, company = found
    return CompanyContext(user=user, company=company, role=membership.role)


def require_role(role: Role):
    """Dependency: caller's role must be at least `role`."""

    def check_role(ctx: Annotated[CompanyContext, Depends(current_context)]) -> CompanyContext:
        if _ROLE_RANK[ctx.role] < _ROLE_RANK[role]:
            raise AppError(403, "forbidden", f"This needs the {role.value} role.")
        return ctx

    return check_role


CurrentUser = Annotated[User, Depends(current_user)]
CurrentClaims = Annotated[TokenClaims, Depends(current_claims)]
ViewerContext = Annotated[CompanyContext, Depends(require_role(Role.viewer))]
EditorContext = Annotated[CompanyContext, Depends(require_role(Role.editor))]
OwnerContext = Annotated[CompanyContext, Depends(require_role(Role.owner))]
