"""The public HS code service: one implementation behind the REST API (api/public.py) and the
MCP server (mcp_server.py), so both transports answer alike and share one set of limits.

Read-only and touching no company's data, so no sign-in:
- search: the official 6-digit lines closest in meaning (one embedding call).
- suggest: the app's suggestion path (hs_suggestions.propose_codes) as a company with no past
  orders. Each call is an AI call, so it's limited per caller and in total per hour
  (settings public_hs_suggestions_*).
"""

from starlette.requests import Request

from app.core.config import get_settings
from app.core.errors import AppError
from app.core.rate_limit import RateLimiter
from app.database.session import open_session
from app.schemas.public import (
    MAX_PRODUCT_CHARS,
    MAX_TARIFF_RESULTS,
    HsSuggestionPublicOut,
    HsSuggestionsOut,
    TariffLineOut,
    TariffSearchOut,
)
from app.services import hs_suggestions as hs_service

NOT_A_RULING = "Not a ruling. Confirm a code with customs or a licensed broker before you ship."
per_caller = RateLimiter("HS code suggestions")
everyone = RateLimiter("HS code suggestions from all callers")


def caller_address(request: Request | None) -> str:
    """The first X-Forwarded-For entry (set by the website's proxy and Cloud Run's front end),
    else the peer. A caller can set it, so the per-caller limit is about fairness; the total
    limit is the cap."""
    if request is None:
        return "unknown"
    forwarded = request.headers.get("x-forwarded-for", "")
    return forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown")


def limits() -> dict[str, int]:
    settings = get_settings()
    return {
        "perCallerPerHour": settings.public_hs_suggestions_per_hour,
        "totalPerHour": settings.public_hs_suggestions_total_per_hour,
    }


def _product(text: str) -> str:
    text = " ".join((text or "").split())
    if not text:
        raise AppError(
            422,
            "product_required",
            "Describe the product: what it is, what it's made of, what it's for.",
        )
    return text[:MAX_PRODUCT_CHARS]


def search(query: str, limit: int) -> TariffSearchOut:
    limit = max(1, min(limit, MAX_TARIFF_RESULTS))
    with open_session() as db:
        headings, method = hs_service.candidate_headings(db, _product(query), limit)
    return TariffSearchOut(
        lines=[TariffLineOut(code=h.code, description=h.description) for h in headings],
        search=method,
    )


def suggest(product: str, destination: str, caller: str) -> HsSuggestionsOut:
    product = _product(product)  # an empty request doesn't use up the caller's limit
    per_caller.check(caller, get_settings().public_hs_suggestions_per_hour)
    everyone.check("all", get_settings().public_hs_suggestions_total_per_hour)
    with open_session() as db:
        proposal = hs_service.propose_codes(db, product, (destination or "").strip(), [])
    return HsSuggestionsOut(
        suggestions=[
            HsSuggestionPublicOut(
                hs_code=c.hs_code,
                official_description=c.heading.description if c.heading else None,
                reason=c.reason,
                based_on=[b.ref for b in c.based_on],
            )
            for c in proposal.codes
        ],
        note=NOT_A_RULING,
    )
