"""Who is calling (Firebase token) and what they may touch (Postgres membership)."""

import logging
import threading
import time
from typing import Annotated

import firebase_admin
from fastapi import Depends, Header, Request
from firebase_admin import auth as fb_auth
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.context import CompanyContext, TokenClaims
from app.core.errors import AppError
from app.database.models import Role, User
from app.database.session import get_db
from app.services import accounts

_ROLE_RANK = {Role.viewer: 0, Role.editor: 1, Role.owner: 2}

# Checking whether a session was revoked means asking Firebase about the user, a network round
# trip on every request. The answer is kept per user for a minute: a sign-out-everywhere is
# honoured at once on this instance and within REVOCATION_TTL_SECONDS on the others.
REVOCATION_TTL_SECONDS = 60
_revocations: dict[
    str, tuple[float, int, bool]
] = {}  # uid -> (checked_at, valid_after_ms, disabled)
_revocations_lock = threading.Lock()

log = logging.getLogger(__name__)


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


def set_password_user(email: str, password: str, name: str) -> str:
    """A Firebase email-and-password sign-in for a demo account, verified, created or given this
    password. Returns its uid. For seeds only (app/seed_demo_data.py --password)."""
    app = _firebase_app()
    try:
        user = fb_auth.get_user_by_email(email, app=app)
    except fb_auth.UserNotFoundError:
        user = fb_auth.create_user(
            email=email, password=password, email_verified=True, display_name=name, app=app
        )
    else:
        fb_auth.update_user(user.uid, password=password, email_verified=True, app=app)
    return user.uid


def _session_state(uid: str) -> tuple[int, bool]:
    """(tokens valid after, in ms; account disabled) for a user, cached briefly."""
    now = time.monotonic()
    with _revocations_lock:
        hit = _revocations.get(uid)
    if hit and now - hit[0] < REVOCATION_TTL_SECONDS:
        return hit[1], hit[2]
    try:
        user = fb_auth.get_user(uid, app=_firebase_app())
    except fb_auth.UserNotFoundError:
        raise AppError(401, "unauthenticated", "Invalid or expired sign-in token.")
    state = (now, user.tokens_valid_after_timestamp or 0, bool(user.disabled))
    with _revocations_lock:
        if len(_revocations) > 10_000:
            _revocations.clear()
        _revocations[uid] = state
    return state[1], state[2]


def _verify_firebase(token: str) -> TokenClaims:
    try:
        decoded = fb_auth.verify_id_token(token, app=_firebase_app())
    except (ValueError, fb_auth.InvalidIdTokenError, fb_auth.ExpiredIdTokenError) as error:
        # The error type says why (expired, wrong project, malformed); the token is never logged.
        log.info("auth.token_rejected", extra={"reason": type(error).__name__})
        raise AppError(401, "unauthenticated", "Invalid or expired sign-in token.")
    # Same rule as firebase-admin's check_revoked, with the user lookup cached.
    valid_after_ms, disabled = _session_state(decoded["uid"])
    if disabled:
        raise AppError(401, "account_disabled", "This account is disabled.")
    if decoded.get("iat", 0) * 1000 < valid_after_ms:
        raise AppError(401, "session_revoked", "Session ended. Please sign in again.")
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
    with _revocations_lock:
        _revocations.pop(uid, None)
    log.info("auth.sessions_revoked")


def current_claims(authorization: Annotated[str | None, Header()] = None) -> TokenClaims:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise AppError(401, "unauthenticated", "Sign in required.")
    claims = verify_token(token)
    if not claims.email_verified:
        raise AppError(403, "email_not_verified", "Verify your email address first.")
    return claims


def current_user(
    request: Request,
    claims: Annotated[TokenClaims, Depends(current_claims)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    user = accounts.get_or_create_user(db, uid=claims.uid, email=claims.email, name=claims.name)
    # The request log line in main.py reads these, so each request is tied to who made it,
    # including those before a company exists (/me, onboarding, invites).
    request.state.user_id = str(user.id)
    return user


def current_context(
    request: Request,
    user: Annotated[User, Depends(current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> CompanyContext:
    found = accounts.find_user_company_membership(db, user.id)
    if not found:
        raise AppError(403, "onboarding_required", "Finish onboarding to create your company.")
    membership, company = found
    request.state.company_id = str(company.id)
    return CompanyContext(user=user, company=company, role=membership.role)


def require_role(role: Role):
    """Dependency: caller's role must be at least `role`."""

    def check_role(ctx: Annotated[CompanyContext, Depends(current_context)]) -> CompanyContext:
        if _ROLE_RANK[ctx.role] < _ROLE_RANK[role]:
            log.info("auth.role_too_low", extra={"role": ctx.role.value, "needed": role.value})
            raise AppError(403, "forbidden", f"This needs the {role.value} role.")
        return ctx

    return check_role


CurrentUser = Annotated[User, Depends(current_user)]
CurrentClaims = Annotated[TokenClaims, Depends(current_claims)]
ViewerContext = Annotated[CompanyContext, Depends(require_role(Role.viewer))]
EditorContext = Annotated[CompanyContext, Depends(require_role(Role.editor))]
OwnerContext = Annotated[CompanyContext, Depends(require_role(Role.owner))]
