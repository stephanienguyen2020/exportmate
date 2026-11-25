"""The public REST API: HS code tools with no sign-in (services/public_hs.py, which the MCP
server also uses), and its own OpenAPI spec listing only what's public.

Tag a route "public" to put it in the public spec; the developer docs (#/developers) are built
from that spec, so they show exactly what the server serves.
"""

from typing import Annotated

from fastapi import APIRouter, Query, Request
from fastapi.openapi.utils import get_openapi

from app.schemas.common import SuccessResponse, success_response
from app.schemas.public import (
    MAX_PRODUCT_CHARS,
    MAX_TARIFF_RESULTS,
    HsSuggestionsOut,
    SuggestRequest,
    TariffSearchOut,
)
from app.schemas.public import example_product as _example
from app.services import public_hs

PUBLIC_TAG = "public"
router = APIRouter(tags=[PUBLIC_TAG])


@router.get("/public/tariff-lines", response_model=SuccessResponse[TariffSearchOut])
def search_tariff_lines(
    query: Annotated[
        str,
        Query(
            min_length=1,
            max_length=MAX_PRODUCT_CHARS,
            description="A product description.",
            examples=[_example()],
        ),
    ],
    limit: Annotated[
        int,
        Query(ge=1, le=MAX_TARIFF_RESULTS, description="How many lines to return."),
    ] = 10,
):
    """The official 6-digit HS lines closest in meaning to a product description."""
    return success_response(public_hs.search(query, limit))


@router.post(
    "/public/hs-suggestions",
    response_model=SuccessResponse[HsSuggestionsOut],
    openapi_extra={"x-rate-limited": True},
    responses={
        429: {"description": "Over the hourly limit (x-rate-limit); the message says when."},
        503: {"description": "The AI step failed. Try again in a minute."},
    },
)
def suggest_hs_codes(body: SuggestRequest, request: Request):
    """Up to 3 HS codes for a product, most likely first, each with a reason and the official
    tariff lines it relied on: the app's suggestions, made with no company history. An AI
    assessment, not a ruling."""
    return success_response(
        public_hs.suggest(body.product, body.destination, public_hs.caller_address(request))
    )


@router.get("/public/openapi.json", include_in_schema=False)
def public_spec(request: Request) -> dict:
    """OpenAPI 3.1 for the public routes only (the full spec, /api/v1/openapi.json, lists the
    signed-in API too)."""
    return public_openapi(request.app.routes, request.app.version)


def public_openapi(app_routes: list, version: str) -> dict:
    """The spec of the operations tagged public, with only the schemas they reference, and each
    rate-limited operation's limits from settings (x-rate-limit), so the docs never state a
    limit the server doesn't apply. (Built from the full spec: included routers stay nested in
    app.routes, and get_openapi is what walks them.)"""
    full = get_openapi(
        title="ExportMate public API",
        version=version,
        description="HS code tools with no sign-in. Suggestions are AI assessments, not rulings.",
        routes=app_routes,
    )
    paths: dict = {}
    for path, operations in full.get("paths", {}).items():
        public = {m: op for m, op in operations.items() if PUBLIC_TAG in op.get("tags", [])}
        for operation in public.values():
            if operation.pop("x-rate-limited", False):
                operation["x-rate-limit"] = public_hs.limits()
        if public:
            paths[path] = public
    schemas = full.get("components", {}).get("schemas", {})
    keep: dict = {}
    pending = _refs(paths)
    while pending:
        name = pending.pop()
        if name not in keep and name in schemas:
            keep[name] = schemas[name]
            pending |= _refs(schemas[name])
    spec = {k: v for k, v in full.items() if k != "components"} | {"paths": paths}
    if keep:
        spec["components"] = {"schemas": dict(sorted(keep.items()))}
    return spec


def _refs(node) -> set[str]:
    """Schema names referenced anywhere under `node` ("#/components/schemas/<name>")."""
    if isinstance(node, dict):
        found = {node["$ref"].rsplit("/", 1)[-1]} if isinstance(node.get("$ref"), str) else set()
        return found.union(*(_refs(v) for v in node.values()))
    if isinstance(node, list):
        return set().union(*(_refs(v) for v in node))
    return set()
