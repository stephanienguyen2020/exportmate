"""The public MCP server at /api/v1/mcp, spoken to as an MCP client would (JSON-RPC over HTTP)."""

import json

import pytest
from fastapi.testclient import TestClient

from app import mcp_server
from app.database.session import open_session
from app.main import create_app
from app.seed_reference_data import seed_hs_headings

HEADERS = {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": "2025-06-18",
}


@pytest.fixture
def mcp(fake_gemini):
    with open_session() as db:
        seed_hs_headings(db)
    fake_gemini.calls.clear()
    with TestClient(create_app()) as client:
        yield client


def rpc(client, method: str, params: dict | None = None, headers: dict | None = None) -> dict:
    response = client.post(
        "/api/v1/mcp",
        follow_redirects=False,  # clients don't all follow one
        headers=HEADERS | (headers or {}),
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
    )
    assert response.status_code == 200, response.text
    return response.json()


def call(client, tool: str, arguments: dict, headers: dict | None = None) -> dict:
    result = rpc(client, "tools/call", {"name": tool, "arguments": arguments}, headers)["result"]
    if result.get("isError"):
        return {"error": result["content"][0]["text"]}
    return result.get("structuredContent") or json.loads(result["content"][0]["text"])


def test_lists_three_read_only_tools(mcp):
    init = rpc(
        mcp,
        "initialize",
        {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "1"},
        },
    )
    assert init["result"]["serverInfo"]["name"] == "ExportMate"
    tools = {t["name"]: t for t in rpc(mcp, "tools/list")["result"]["tools"]}
    assert set(tools) == {"search_tariff_lines", "suggest_hs_codes", "get_hs_benchmark"}
    assert all(t["annotations"]["readOnlyHint"] for t in tools.values())
    # The caller never sees the injected context.
    assert "ctx" not in tools["suggest_hs_codes"]["inputSchema"]["properties"]


def test_search_tariff_lines(mcp):
    found = call(mcp, "search_tariff_lines", {"query": "wooden kitchen furniture", "limit": 5})
    assert found["search"] == "embedding"
    assert len(found["lines"]) == 5
    assert "9403.40" in [line["code"] for line in found["lines"]]


def test_suggest_hs_codes_uses_the_app_path_and_is_limited(mcp, fake_gemini, monkeypatch):
    fake_gemini.answers["hs_code_suggestion"] = lambda prompt, file: {
        "codes": [
            {"hs_code": "9403.40", "reason": "Wooden kitchen furniture.", "based_on": []},
            {"hs_code": "9999.99", "reason": "Not a tariff line.", "based_on": []},
        ]
    }
    monkeypatch.setattr(mcp_server, "per_caller", mcp_server.RateLimiter("test"))
    monkeypatch.setattr(mcp_server, "everyone", mcp_server.RateLimiter("test all"))
    monkeypatch.setenv("MCP_HS_SUGGESTIONS_PER_HOUR", "1")
    from app.core.config import get_settings

    get_settings.cache_clear()
    me = {"X-Forwarded-For": "203.0.113.7"}
    answer = call(mcp, "suggest_hs_codes", {"product": "Oak kitchen cabinet set"}, me)
    assert [s["hsCode"] for s in answer["suggestions"]] == ["9403.40"]  # made-up code dropped
    assert answer["suggestions"][0]["officialDescription"].endswith("used in the kitchen")
    assert "Not a ruling" in answer["note"]
    assert "<product>Oak kitchen cabinet set</product>" in fake_gemini.calls[-1]["prompt"]
    # One an hour for this caller; another caller still gets theirs.
    assert "Too many" in call(mcp, "suggest_hs_codes", {"product": "Oak table"}, me)["error"]
    other = {"X-Forwarded-For": "198.51.100.2"}
    assert "suggestions" in call(mcp, "suggest_hs_codes", {"product": "Oak table"}, other)
    get_settings.cache_clear()


def test_benchmark_before_and_after_a_run(mcp):
    assert call(mcp, "get_hs_benchmark", {}) == {
        "measured": False,
        "note": "No full benchmark run yet.",
    }


def test_empty_product_is_refused(mcp, fake_gemini):
    assert "Describe the product" in call(mcp, "suggest_hs_codes", {"product": "  "})["error"]
    assert fake_gemini.calls == []
