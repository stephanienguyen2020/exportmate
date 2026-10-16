# Knowledge graph

Data for phase 1 of [`docs/NEWS_IMPACT_PLAN.md`](../../../docs/NEWS_IMPACT_PLAN.md): following
links from a news article to the orders it may hit (material → products made from it →
suppliers that source it → their orders). Not loaded into Postgres or used by the API yet.

## Files

| Path | What | Made by |
| --- | --- | --- |
| `data/eudr_products.json` | EUDR Annex I: for each commodity (wood, cocoa, coffee, oil palm, rubber, soya, cattle), the HS codes of the products made from it | `build_eudr_products.py` (official, regenerate; don't edit by hand) |
| `data/material_chain.json` | Per industry (wood so far): products by HS code, "used to make" / "by-product" links between them, each citing a source; and the materials (species) news and documents name | By hand, from the FAO definitions and HS headings. `reviewed: false` until a person checks a link |
| `build_eudr_products.py` | Downloads the EUDR version named in `seed_data/regulation_sources.json` and parses Annex I | `uv run python -m app.knowledge_graph.build_eudr_products` |
| `sources/` (git-ignored) | Downloaded EUDR HTML and FAO PDF, to check quotes | Download again from the URLs in `material_chain.json` `sources` |

Company data stays with the company seeds: each supplier's `sourcing` (which material it buys,
from which country, in what form, and how we know) is in `seed_data/demo_company.json` and
`seed_data/us_furniture_company.json`.

## Where code will go

The backend's layers stay as they are: tables in `database/models/`, SQL in `database/queries/`,
the graph walk in `services/`, loading in the reference seed. This folder holds only the
graph's source data and the scripts that build it.

## Known gaps

- Only wood has a chain; other commodities have only EUDR's commodity → product links.
- Russia (RU) and Gabon (GA), named in supplier sourcing, aren't in `seed_data/reference.json` `countries` yet.
