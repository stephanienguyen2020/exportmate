"""The public REST API (/api/v1/public/...) and its OpenAPI spec."""

import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.database.session import open_session
from app.main import create_app
from app.seed_reference_data import seed_hs_headings
from app.services import public_hs


@pytest.fixture
def tariff(fake_gemini):
    with open_session() as db:
        seed_hs_headings(db)
    fake_gemini.calls.clear()


def test_search_tariff_lines_needs_no_sign_in(client, tariff):
    response = client.get(
        "/api/v1/public/tariff-lines", params={"query": "wooden kitchen furniture", "limit": 3}
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["search"] == "embedding" and len(data["lines"]) == 3
    assert client.get("/api/v1/public/tariff-lines", params={"query": ""}).status_code == 422


@pytest.fixture
def served(tariff):
    """A client that runs the app's lifespan, which the MCP endpoint needs."""
    with TestClient(create_app()) as client:
        yield client


def test_suggestions_share_the_mcp_limit(served, fake_gemini, monkeypatch):
    client = served
    fake_gemini.answers["hs_code_suggestion"] = lambda prompt, file: {
        "codes": [{"hs_code": "9403.40", "reason": "Kitchen furniture.", "based_on": []}]
    }
    monkeypatch.setattr(public_hs, "per_caller", public_hs.RateLimiter("test"))
    monkeypatch.setattr(public_hs, "everyone", public_hs.RateLimiter("test all"))
    monkeypatch.setenv("PUBLIC_HS_SUGGESTIONS_PER_HOUR", "2")
    get_settings.cache_clear()
    me = {"X-Forwarded-For": "203.0.113.9"}
    body = {"product": "Oak kitchen cabinet set", "destination": "Germany"}
    response = client.post("/api/v1/public/hs-suggestions", json=body, headers=me)
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["suggestions"][0]["hsCode"] == "9403.40"
    assert data["suggestions"][0]["officialDescription"]
    assert "Not a ruling" in data["note"]
    # Blank text is refused before it uses up the limit.
    blank = client.post("/api/v1/public/hs-suggestions", json={"product": " "}, headers=me)
    assert blank.status_code == 422
    # The second call goes through MCP, the third (REST again) is over the limit of 2.
    mcp = client.post(
        "/api/v1/mcp",
        headers=me | {"Accept": "application/json, text/event-stream"},
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "suggest_hs_codes", "arguments": {"product": "Oak table"}},
        },
    )
    assert mcp.status_code == 200 and not mcp.json()["result"].get("isError")
    limited = client.post("/api/v1/public/hs-suggestions", json=body, headers=me)
    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "rate_limited"
    get_settings.cache_clear()


def test_public_spec_lists_only_public_routes_with_limits(client):
    spec = client.get("/api/v1/public/openapi.json").json()
    assert spec["openapi"].startswith("3.1")
    assert set(spec["paths"]) == {
        "/api/v1/public/tariff-lines",
        "/api/v1/public/hs-suggestions",
        "/api/v1/benchmarks/hs-codes",
    }
    post = spec["paths"]["/api/v1/public/hs-suggestions"]["post"]
    assert post["x-rate-limit"] == public_hs.limits()
    assert "x-rate-limited" not in post
    # The example the docs show comes from the request schema.
    schema = spec["components"]["schemas"]["SuggestRequest"]["properties"]["product"]
    assert schema["examples"]
    # Only what the public routes use; nothing from the signed-in API.
    assert "OrderOut" not in spec["components"]["schemas"]
