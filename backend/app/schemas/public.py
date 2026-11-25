"""The public HS code service's shapes, shared by the REST API (/api/v1/public/...) and the
MCP server (app/mcp_server.py). Descriptions and examples here are what the developer docs
(the website's #/developers page) show, read from the OpenAPI spec and the MCP tool list."""

from functools import lru_cache

from pydantic import Field

from app.schemas.common import CamelCaseModel
from app.seed_data import load_seed_file

MAX_PRODUCT_CHARS = 2000
MAX_TARIFF_RESULTS = 25


@lru_cache
def example_product() -> str:
    """The shortest product description among the benchmark's rulings: a real product, from
    data rather than code."""
    cases = load_seed_file("hs_benchmark.json")["cases"]
    return min((c["description"] for c in cases), key=len)


PRODUCT = Field(
    min_length=1,
    max_length=MAX_PRODUCT_CHARS,
    description="What the product is, what it's made of, and what it's for.",
    examples=[example_product()],
)
DESTINATION = Field(
    default="",
    max_length=100,
    description="Where it ships (a country or market). Optional.",
)
LIMIT = Field(
    default=10,
    ge=1,
    le=MAX_TARIFF_RESULTS,
    description=f"How many lines to return (1–{MAX_TARIFF_RESULTS}).",
)


class SuggestRequest(CamelCaseModel):
    product: str = PRODUCT
    destination: str = DESTINATION


class TariffLineOut(CamelCaseModel):
    code: str = Field(description='The 6-digit HS code, like "1234.56".')
    description: str = Field(description="The official wording, with its heading's path.")


class TariffSearchOut(CamelCaseModel):
    lines: list[TariffLineOut]
    search: str = Field(description='"embedding" (by meaning) or "words" (shared words).')


class HsSuggestionPublicOut(CamelCaseModel):
    hs_code: str = Field(description='6 digits, like "1234.56".')
    official_description: str | None = Field(description="The tariff line's official wording.")
    reason: str = Field(description="Why it fits this product.")
    based_on: list[str] = Field(description="The tariff lines it relied on.")


class HsSuggestionsOut(CamelCaseModel):
    suggestions: list[HsSuggestionPublicOut] = Field(description="Up to 3, most likely first.")
    note: str
