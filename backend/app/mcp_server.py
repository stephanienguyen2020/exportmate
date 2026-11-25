"""ExportMate's MCP server, at /api/v1/mcp (Streamable HTTP, stateless, JSON responses).

Public and read-only: HS code tools that touch no company's data, so an agent can classify a
product, look up the official tariff lines, and see how accurate the suggestions measured.
Company tools (orders, reports) need personal access tokens first; sign-in tokens last an hour,
which MCP clients can't refresh.

- search_tariff_lines: the official 6-digit lines closest in meaning (one embedding call).
- suggest_hs_codes: the same path as the app's suggestions and the benchmark
  (services/hs_suggestions.py propose_codes), as a company with no past orders. Each call is
  an AI call, so it's limited per caller and in total (settings mcp_*).
- get_hs_benchmark: the latest full run of the benchmark (app/hs_benchmark.py).

Docs for people: backend/docs/MCP.md and the website's #/mcp page.
"""

from typing import Any

from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from starlette.requests import Request
from starlette.routing import Route

from app.core.config import get_settings
from app.core.errors import AppError
from app.core.rate_limit import RateLimiter
from app.database.session import open_session
from app.hs_benchmark import latest_run
from app.services import hs_suggestions as hs_service

MAX_PRODUCT_CHARS = 2000
MAX_TARIFF_RESULTS = 25
NOT_A_RULING = "Not a ruling. Confirm a code with customs or a licensed broker before you ship."

server = MCPServer(
    name="ExportMate",
    instructions=(
        "HS code tools from ExportMate. Suggestions are AI assessments, not customs rulings: "
        "show the reason and the official wording with each code, and call get_hs_benchmark "
        "to say how often suggestions measured right."
    ),
)
per_caller = RateLimiter("MCP HS code suggestions")
everyone = RateLimiter("MCP HS code suggestions from all callers")
READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)


def _caller(ctx: Context) -> str:
    """The caller's address: the first X-Forwarded-For entry (set by the website's proxy and
    Cloud Run's front end), else the peer. Good enough to share a limit fairly; the total
    limit holds whatever a caller sends."""
    request = ctx.request_context.request
    if not isinstance(request, Request):
        return "unknown"
    forwarded = request.headers.get("x-forwarded-for", "")
    return forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown")


def _clean(text: str) -> str:
    text = " ".join((text or "").split())
    if not text:
        raise ToolError("Describe the product: what it is, what it's made of, what it's for.")
    return text[:MAX_PRODUCT_CHARS]


@server.tool(annotations=READ_ONLY)
def search_tariff_lines(query: str, limit: int = 10) -> dict[str, Any]:
    """Find the official 6-digit HS subheadings closest in meaning to a product description.

    Searches the Harmonized System lines (from the US Harmonized Tariff Schedule; the first
    6 digits are international). Use it to see the candidate codes and their official wording.
    """
    limit = max(1, min(limit, MAX_TARIFF_RESULTS))
    with open_session() as db:
        headings, method = hs_service.candidate_headings(db, _clean(query), limit)
    return {
        "lines": [{"code": h.code, "description": h.description} for h in headings],
        "search": method,  # "embedding" (by meaning) or "words" (shared words)
    }


@server.tool(annotations=READ_ONLY)
def suggest_hs_codes(product: str, ctx: Context, destination: str = "") -> dict:
    """Suggest up to 3 HS codes (6 digits) for a product, most likely first, each with a reason
    and the official tariff lines it relied on.

    The same suggestions as ExportMate's app, made with no company history. A suggestion is an
    AI assessment, not a ruling: check it against the official wording before you use it.
    """
    settings = get_settings()
    try:
        per_caller.check(_caller(ctx), settings.mcp_hs_suggestions_per_hour)
        everyone.check("all", settings.mcp_hs_suggestions_total_per_hour)
        with open_session() as db:
            proposal = hs_service.propose_codes(db, _clean(product), destination.strip(), [])
    except AppError as error:
        raise ToolError(error.message) from error
    return {
        "suggestions": [
            {
                "hsCode": c.hs_code,
                "officialDescription": c.heading.description if c.heading else None,
                "reason": c.reason,
                "basedOn": [b.ref for b in c.based_on],
            }
            for c in proposal.codes
        ],
        "note": NOT_A_RULING,
    }


@server.tool(annotations=READ_ONLY)
def get_hs_benchmark() -> dict:
    """How accurate the HS code suggestions measured: the latest full run on held-out customs
    rulings, with each rate's 95% interval, the model, and where the rulings come from."""
    with open_session() as db:
        run = latest_run(db)
    if not run:
        return {"measured": False, "note": "No full benchmark run yet."}
    return {
        "measured": True,
        "measuredAt": run.created_at.isoformat(),
        "model": run.model,
        "embeddingModel": run.embedding_model,
        "dataset": run.dataset,
        "cases": run.case_count,
        "metrics": run.metrics,
    }


def mcp_route(path: str) -> Route:
    """The MCP endpoint as a route at exactly `path`. (Mounted as a sub-app, POST {path} would
    redirect to {path}/, which clients don't all follow and which, behind the website's proxy,
    points at the backend's own host.)

    No cookies or sign-in reach these tools, so a DNS rebinding attack gains nothing over
    calling the public URL; the SDK's Host check would only refuse the real domains."""
    app = server.streamable_http_app(
        streamable_http_path=path,
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )
    (route,) = app.routes  # one route, no middleware: it can join FastAPI's routes as is
    assert isinstance(route, Route) and not app.user_middleware
    return route
