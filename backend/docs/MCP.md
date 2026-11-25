# MCP server

ExportMate serves a [Model Context Protocol](https://modelcontextprotocol.io) server so AI agents
(Claude, Cursor, your own) can classify products with the same HS code suggestions the app makes.

- **URL:** `https://<the website>/api/v1/mcp`. The website's nginx passes it to the backend; the
  backend's own Cloud Run URL works too.
- **Transport:** Streamable HTTP, stateless, JSON responses (no SSE stream needed).
- **Auth:** none. Every tool is read-only and touches no company's data.
- **Code:** `app/mcp_server.py`, mounted in `app/main.py`. Tests: `tests/test_mcp_server.py`.

## Connect

Claude Code:

```sh
claude mcp add --transport http exportmate https://<the website>/api/v1/mcp
```

A project's `.mcp.json` (Claude Code; other clients take the same URL in their own config):

```json
{
  "mcpServers": {
    "exportmate": { "type": "http", "url": "https://<the website>/api/v1/mcp" }
  }
}
```

Locally: `http://127.0.0.1:8000/api/v1/mcp` with `uv run uvicorn app.main:app`.

## Tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `search_tariff_lines` | `query` (product description), `limit` (1–25, default 10) | `lines`: `{code, description}` of the official 6-digit HS lines closest in meaning; `search`: `"embedding"` or `"words"` |
| `suggest_hs_codes` | `product` (description, up to 2,000 characters), `destination` (optional) | `suggestions`: up to 3 `{hsCode, officialDescription, reason, basedOn}`, most likely first; `note` |
| `get_hs_benchmark` | none | `measured`; when true, the latest full benchmark run: `measuredAt`, `model`, `embeddingModel`, `dataset` (source, licence, rulings), `cases`, `metrics` (rates with 95% intervals) |

`suggest_hs_codes` runs the app's suggestion path (`services/hs_suggestions.py`
`propose_codes`: tariff search, Gemini, then code keeps only real tariff lines), as a company
with no past orders. It is what the benchmark scores (`app/hs_benchmark.py`), so
`get_hs_benchmark` says how far to trust it.

Every suggestion is an AI assessment, not a customs ruling. The server's instructions ask the
agent to show the reason and the official wording with each code.

## Limits

`suggest_hs_codes` is an AI call, so it is limited in memory per backend instance:
`MCP_HS_SUGGESTIONS_PER_HOUR` per caller address (default 20) and
`MCP_HS_SUGGESTIONS_TOTAL_PER_HOUR` for everyone (default 300). Past a limit the tool returns
an error saying when to try again. The caller address is the first `X-Forwarded-For` entry,
which a caller can set, so the per-caller limit is about fairness; the total limit is the cap.

## Errors

Expected failures (an empty description, a limit, the AI step failing) come back as a tool
result with `isError: true` and a message for the agent to read. Anything else is a crash: the
agent sees `Error executing tool <name>` and the backend logs the traceback.

## Not yet

Company tools (orders, reports, news matches) need a credential an MCP client can keep. Sign-in
tokens (Firebase) last an hour, so these wait for personal access tokens.
