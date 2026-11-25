"""ExportMate's MCP server, at /api/v1/mcp (Streamable HTTP, stateless, JSON responses).

Public and read-only HS code tools that touch no company's data. They call the same service as
the public REST API (services/public_hs.py), so both answer alike and share one set of limits.
Company tools (orders, reports) need personal access tokens first; sign-in tokens last an hour,
which MCP clients can't refresh.

Argument descriptions and examples come from schemas/public.py; the developer docs (#/developers)
read them from tools/list. Docs for people: backend/docs/MCP.md.
"""

from typing import Annotated

from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from starlette.requests import Request
from starlette.routing import Route

from app.core.errors import AppError
from app.database.session import open_session
from app.hs_benchmark import latest_run
from app.schemas.public import DESTINATION, LIMIT, PRODUCT
from app.services import public_hs

server = MCPServer(
    name="ExportMate",
    instructions=(
        "HS code tools from ExportMate. Suggestions are AI assessments, not customs rulings: "
        "show the reason and the official wording with each code, and call get_hs_benchmark "
        "to say how often suggestions measured right."
    ),
)
READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)


def _tool_error(error: AppError) -> ToolError:
    """An expected failure, which the agent reads (any other exception is a crash it can't)."""
    return ToolError(error.message)


@server.tool(annotations=READ_ONLY)
def search_tariff_lines(query: Annotated[str, PRODUCT], limit: Annotated[int, LIMIT] = 10) -> dict:
    """Find the official 6-digit HS subheadings closest in meaning to a product description.

    Searches the Harmonized System lines (from the US Harmonized Tariff Schedule; the first
    6 digits are international). Use it to see the candidate codes and their official wording.
    """
    try:
        return public_hs.search(query, limit).model_dump(by_alias=True)
    except AppError as error:
        raise _tool_error(error) from error


@server.tool(annotations=READ_ONLY, meta={"rateLimit": public_hs.limits()})
def suggest_hs_codes(
    product: Annotated[str, PRODUCT],
    ctx: Context,
    destination: Annotated[str, DESTINATION] = "",
) -> dict:
    """Suggest up to 3 HS codes (6 digits) for a product, most likely first, each with a reason
    and the official tariff lines it relied on.

    The same suggestions as ExportMate's app, made with no company history. A suggestion is an
    AI assessment, not a ruling: check it against the official wording before you use it.
    """
    request = ctx.request_context.request
    caller = public_hs.caller_address(request if isinstance(request, Request) else None)
    try:
        return public_hs.suggest(product, destination, caller).model_dump(by_alias=True)
    except AppError as error:
        raise _tool_error(error) from error


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
