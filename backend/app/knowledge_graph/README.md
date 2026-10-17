# Knowledge graph

How News watch finds the orders an article may hit by following links (material → products
made from it → suppliers that buy it → their orders), not only by comparing HS codes. Why, and
the business decisions: phase 1 of [`docs/NEWS_IMPACT_PLAN.md`](../../../docs/NEWS_IMPACT_PLAN.md).
This file is the technical side: the data, how the walk works, what's built and what's next.

## 1. Status

### Done

| # | Step | Where |
| --- | --- | --- |
| 1 | Plan, and where the material chain comes from | `docs/NEWS_IMPACT_PLAN.md`, section 3 below |
| 2 | Seed data: EUDR Annex I parsed (93 codes, 7 commodities), the wood chain (14 products, 25 links, each citing FAO or the HS headings), 11 materials | `data/`, `build_eudr_products.py` |
| 3 | Tables and loading: graph nodes, edges and sources (reference seed), supplier sourcing (company seeds) | `database/models/knowledge_graph.py`, `seed_reference_data.py`, `seed_demo_data.py` |
| 4 | The walk, and News watch suggestions from it with a cited path; the HS-heading rule kept as one path | `services/knowledge_graph.py`, `services/news_matches.py` |
| 5 | The news scan records what each article names (`mentions`) | `ai/server/scan.js`, `ai/server/mentions.js` |
| 6 | News watch shows the path under each suggestion, with source links | `frontend/ai/news/NewsOrders.tsx` |
| 7 | Deployed to `skilful-scarab-511320-q9` and checked live (16 Oct 2026): a real scan's alerts reached orders through suppliers | |
| 8 | Broad words ("timber", "hardwood") and product words ("plywood", "logs") | `genericTerms`, `aliases` in `material_chain.json`; `services/graph_words.py` |
| 9 | Links checked by AI (`aiCheck`), less common routes marked `secondary`, two missing links added | `material_chain.json` |
| 10 | Sourcing on the supplier form and API ("Materials it buys") | `services/supplier_sourcing.py`, `frontend/src/trade-map/forms.tsx` |
| 11 | AI suggests sourcing from uploaded certificates; a person ticks what to keep | `services/supplier_documents.py` |
| 12 | Measuring: each verdict keeps how it was found; `GET /news-matches/accuracy`; expected mentions in the scan eval (first run: 100% mention recall) | `services/news_matches.py`, `ai/server/eval/scan-*.js` |
| 13 | Steps 8–12 deployed from main (`ca87b60`) and rechecked live (17 Oct 2026): "hardwood" now reaches orders through suppliers; furniture paths go through sawn wood | |
| 14 | Verdicts used automatically: links people keep rejecting are doubted, avoided when an equally short path exists, and marked on the path | `services/graph_feedback.py` |
| 15 | Material chain page (Rules & news): links with sources, checks and verdicts, and how each way of suggesting did | `GET /knowledge-graph/chain`, `frontend/src/MaterialChain.tsx` |

### Next

| # | Step | Why |
| --- | --- | --- |
| 1 | Live News watch reads alerts from the AI service in `exportmate-app`, which doesn't write `mentions` yet: deploy main there, or move News watch to `skilful-scarab` (asked Loc, 17 Oct) | Until then real users get HS-heading suggestions only |
| 2 | Offline building pipeline, then more industries (coffee, cocoa, textiles) | Only wood has a chain (section 7) |
| 3 | GraphRAG in the assistant (`query_graph` tool) | Questions about connections (section 8) |
| 4 | A graph database (Neo4j) only if the walk outgrows Postgres | Section 9 |
| 5 | Draw paths on the trade map | Demos |
| — | Housekeeping: re-seed the sample stock in `skilful-scarab` Firestore (`npm run seed`); 3 scan-eval cases fail on its old SKUs | Not graph work |

## 2. Data model

Postgres, next to orders and suppliers. A walk joins these tables to orders and suppliers instead
of copying them into a separate graph.

| Table | Rows | Scope |
| --- | --- | --- |
| `graph_sources` | What links cite: `eudr-annex-i`, `fao-jfsq`, `hs-nomenclature` (title, URL) | Shared |
| `graph_nodes` | `commodity.wood` (EUDR commodity, all its HS codes, its broad words), `wood.plywood` (a chain product, HS prefixes, words for it), `material.acacia` (species, scientific names, words, wood type) | Shared |
| `graph_edges` | `wood.veneer` *used to make* `wood.plywood`, or *by-product*; source, quote or basis; `ai_check` (who checked it, verdict, why); `secondary` (used only when no equally short path avoids it) | Shared |
| `supplier_sourcing` | A supplier buys `material.acacia` from `VN` as `wood.roundwood`; `basis` (how we know) | Per company, through its suppliers |
| `news_order_reviews.via`, `.path` | How a reviewed suggestion was found (`supplier` / `hs`) and its steps | Per company |

```
Article "Laos limits acacia log exports"            (mentions from the scan)
   │ names acacia, LA, HS 4403
   ▼
supplier_sourcing: Binh Phu Wood buys acacia from LA as logs
   │ bought as
   ▼
graph_edges: logs ─used to make→ veneer ─used to make→ plywood     (FAO quotes)
   │ this order's product
   ▼
orders: PO-2291 acacia plywood (HS 4412.33) → EU
```

## 3. Where the data comes from

| Data | Source | Shared or per company |
| --- | --- | --- |
| Commodity → products | EUDR Annex I, parsed by `build_eudr_products.py` from the version the checklists cite | Shared |
| The chain (product → product) | Written from official sources, checked by AI (`aiCheck`), loaded by the reference seed | Shared |
| Supplier sourcing | The supplier form, certificates (AI suggests, a person keeps), demo seeds | Per company |
| Orders, suppliers | The company's own records | Per company |
| What an article names | Gemini in each news scan (`mentions`), cleaned by `mentions.js` | Per alert |

There is no public dataset of "HS code A is made from HS code B", so the chain is built from
official anchors and every link cites one:

| Source | What it gives | Use |
| --- | --- | --- |
| **EUDR Annex I**: Regulation (EU) 2023/1115 (in `seed_data/regulation_sources.json`); overviews [Prewave](https://help.prewave.com/en/articles/310638-eudr-relevant-hs-codes-based-on-annex-i), [Coolset](https://www.coolset.com/academy/which-products-are-covered-under-the-eudr-sector-by-sector-overview) | For wood, cocoa, coffee, oil palm, rubber, soya and cattle, the HS codes of every product made from them | Commodity → products. Official and citable |
| **HS structure**: [USITC HTS](https://hts.usitc.gov/), seeded as `hs_headings` (6,573) | Chapters run raw → processed: 4403 logs → 4407 sawn → 4408 veneer → 4412 plywood; 94 furniture | The steps of a chain |
| **FAO forest product definitions (JFSQ)**: [PDF](https://fao.org/forestry-fao/35789-0902b3c041384fd87f2451da2bb9237.pdf) | Roundwood → sawnwood, veneer, chips → panels, pulp → paper, in definitions we quote | The quotes behind 15 wood links |
| **UN BEC Rev.5**: [manual](https://unstats.un.org/unsd/trade/classifications/Manual%20of%20the%20Fifth%20Revision%20of%20the%20BEC%20(Edited)-%20EN.pdf); HS ↔ BEC/NAICS/BEA in the R [`concordance`](https://insongkim.r-universe.dev/concordance) package | Each HS code's stage: primary, processed, final | Ordering a new industry's chain |
| **Input–output tables**: [US BEA](https://www.bea.gov/industry/input-output-accounts-data); on an HS basis in the [Conconi appendix](https://conconi.ulb.be/Appendix_RoO.pdf) | Which industries buy from which | Later, suggesting links for many industries; coarse |
| **US Customs rulings (CROSS)**: [rulings.cbp.gov](https://rulings.cbp.gov/), as in the [ATLAS paper](https://arxiv.org/pdf/2509.18400) | Product descriptions → 10-digit HS codes | Mapping free-text products to HS codes |

### Files here

| Path | What | Made by |
| --- | --- | --- |
| `data/eudr_products.json` | EUDR Annex I by commodity: CN code, HS code, `partOfCode` (the Annex's "ex"), `appliesFrom`, notes | `build_eudr_products.py`; regenerate, don't edit |
| `data/material_chain.json` | Per industry: products (HS codes, `aliases`), links (source, quote or basis, `aiCheck`, `secondary`), `genericTerms`; and the materials (scientific names, words, wood type) | By hand from the sources above |
| `build_eudr_products.py` | Downloads the EUDR version in `seed_data/regulation_sources.json` and parses Annex I | `uv run python -m app.knowledge_graph.build_eudr_products` |
| `sources/` (git-ignored) | The downloaded EUDR HTML and FAO PDF, to check quotes | Download again from `material_chain.json` `sources` |

Supplier sourcing for the demo companies is in `seed_data/demo_company.json` and
`seed_data/us_furniture_company.json` (`suppliers[].sourcing`).

## 4. How the walk works

`services/knowledge_graph.py` (`GraphWalker`), per alert, for one company's open orders:

1. **Read what the article names** (`GraphMentions`): materials as words, HS codes, origin
   countries, markets. A word is matched (`services/graph_words.py`) to a species ("acacia"),
   else a broad word ("timber" = every wood, "hardwood" = non-coniferous and tropical; the more
   specific word in a phrase wins), or a chain product ("plywood", which counts like an HS code).
   Markets are our codes; a country counts as its market ("GB" is UK, "NL" is EU); unknown codes
   are ignored.
2. **Suppliers that buy it:** sourcing lines matching the named materials, the named origin
   countries, or both when both are named.
3. **Walk the chain** (`walk_downstream`, one recursive SQL query, at most 4 links, no cycles)
   from what each supplier buys to the order's product. Between equally short paths, the one with
   fewer `secondary` links wins. When the article names a chain product, the path must go through
   it, and the order's product must be made from it.
4. **By HS heading:** an order whose heading the article names, or an alert's stock item names
   (shipping to one of its markets), is suggested too: the rule News watch had before the graph.
5. **Markets:** when the article names markets, only orders shipping there.

Each match carries its `path` (steps: mention → supplier → products → order, each link with its
source title, URL and quote) and a `reason` built from it. Same input, same answer.

### Rules at a glance

Every rule and number the graph uses, with where it lives in code. Change both together.

| Stage | Rule | In code |
| --- | --- | --- |
| What an article names | At most 8 of each kind; a material is 2–60 letters; an HS code 4–10 digits; countries and markets are 2-letter codes; anything else is dropped | `ai/server/mentions.js` (`MAX_PER_KIND`, patterns) |
| Words → materials | A named species wins; otherwise a broad word stands for its materials ("timber": every wood; "hardwood": non-coniferous and tropical; "softwood": coniferous); in one phrase the more specific broad word wins ("tropical timber" over "timber"); words are matched whole | `services/graph_words.py`; `genericTerms` in `material_chain.json` |
| Words → products | A product word ("plywood", "logs", "MDF") counts like an HS code the article names | `aliases` in `material_chain.json` |
| HS code → product | The product with the longest matching HS prefix ("4412.33" → plywood, 4412) | `product_of_hs_code` |
| Markets | Our market codes; a country counts as its market ("GB" → UK, "NL" → EU); unknown codes are ignored, so they never hide every order | `GraphWalker.known_markets` |
| Which suppliers | Those buying a named material; or from a named origin country; both when both are named; neither named → no supplier path | `GraphWalker.find_matches` |
| How far | At most 4 links from what a supplier buys to the order's product; cycles aren't followed | `MAX_LINKS`; `walk_downstream` |
| Which path | Shortest first; then fewest doubted links; then fewest `secondary` links. When the article names a product, the path goes through it, and the order's product must be made from it (otherwise no supplier path) | `chain_cost`, `_chain_through`, `_through_supplier` |
| By HS heading | Same first 4 digits as an HS code the article or an alert's stock item names; a stock item's markets apply; used when no supplier path reaches the order | `GraphWalker.find_matches` |
| One suggestion per order | The first path found wins: the article's mentions before the alert's stock items | `news_matches.suggest_orders` |
| Doubted link | At a company: at least 2 rejections and rejected more often than confirmed. Across companies: at least 5 rejections, rejected more often than confirmed. Counted per link on the paths of reviewed suggestions | `services/graph_feedback.py` (`MIN_COMPANY_REJECTIONS`, `MIN_SHARED_REJECTIONS`) |
| Doubted path | Kept, but its doubted steps are marked, the reason says so, and it's listed after the others | `GraphWalker.find_matches`, `_supplier_match` |
| Sourcing from a certificate | At most 20 materials read; only ones the graph knows; a country only if on the map ("UK" → GB); a form only from that material's chain; one suggestion per material and country | `supplier_sourcing.suggest_sourcing` |
| Sourcing lines | One per material and country, at most 20 per supplier; `basis` defaults to "Entered on the trade map", or "From <document kind> (<file>)" when ticked from a certificate | `schemas/trade_map.py`, `supplier_sourcing.save_sourcing` / `add_sourcing` |

## 5. Where an LLM is used

| Step | LLM? | |
| --- | --- | --- |
| What an article names | Yes, Gemini in the scan | Code keeps only well-formed values (`mentions.js`) and only nodes the graph knows |
| Sourcing from certificates | Yes, Gemini reading the file | Matched to graph materials; a person ticks what to keep |
| Checking links | Yes, once by hand (`aiCheck`); later the pipeline's reviewer | Section 7 |
| The walk | No | SQL and code: repeatable, every path citable |
| The explanation | No | The path in a template |

## 6. Who controls the links

- The shared chain is ours to keep correct, like a tariff database. There is no per-company
  switch for each link: a company's own sourcing and orders already decide which part of the
  graph is walked, and most links never touch it.
- Companies give feedback by confirming or rejecting suggestions. Verdicts keep the way and path
  (`via`, `path`, with each product step's node key); `GET /news-matches/accuracy` counts them by
  way and by link.
- Links people keep rejecting are **doubted** (`services/graph_feedback.py`): at a company once its
  people rejected suggestions through the link at least 2 times and more often than they
  confirmed them; for everyone once 5 rejections across companies say the same. Between equally
  short paths the walk takes the one with fewer doubted links (then fewer `secondary` ones); a
  path that still needs one is kept but marked (`path[].doubt`, "People have often rejected a
  link on this path.") and listed last. Nothing is hidden and nobody edits links by hand.
- Everyone in the company sees the chain, each link's source, check and verdicts, and how each
  way of suggesting did, on Rules & news › Material chain (`GET /knowledge-graph/chain`).
- `secondary` marks a less common route (veneer → furniture: veneer is mostly a surface).

## 7. Building chains offline (next)

A script like `build_eudr_products.py`, with a writer and a reviewer (generator–critic, like the
assistant's auditor). Plain calls with fixed schemas, not agents: the steps are fixed, so it's
cheaper, repeatable and testable.

| Step | Who | What |
| --- | --- | --- |
| 1. Sources | Code (an agent with search only to find sources for a brand-new industry) | Download the official texts: EUDR Annex I, HS chapter notes, FAO/ICO definitions |
| 2. Write | LLM, writer role | Propose links "A is used to make B" by HS code, with the exact quote and a confidence |
| 3. Check | Code | The quote is in the source, both HS codes exist in `hs_headings`, no duplicates or loops |
| 4. Review | LLM, reviewer role (own prompt) | A verdict and reason per link, filling `aiCheck` (`by`: the model); doubtful links go back to the writer once |
| 5. Our check | Us | Only what the reviewer or code flagged |
| 6. Release | Code | Write the industry into `material_chain.json`; the reference seed loads it |

Shared instructions (how to read HS chapter notes, what counts as "made from") can be one prompt
section or a skill used by both roles.

## 8. GraphRAG in the assistant (next)

GraphRAG: for a question, fetch the relevant part of the graph (nodes and paths) and give it to
Gemini as context. Today the assistant's RAG Engine finds similar text chunks, which can't follow
connections across records ("which of my orders depend on wood from Laos?").

- One more read-only tool for the assistant's agents: `query_graph` (scope `orders`), calling a
  backend endpoint that runs the same walk with the user's token, for a material, country, HS
  code or what-if ("if Vietnam restricts acacia log exports").
- The agent gets paths; the auditor (`ai/server/review.js`) checks the answer cites them, as for
  `query_orders`. Gemini explains; the walk decides.
- Later: the company report's news → orders section and suggested solutions take paths too.

## 9. Graph database (Neo4j): how it works and when

**What it is.** A graph database stores nodes and relationships as first-class records: each node
keeps direct pointers to its relationships ("index-free adjacency"), so following a link costs
the same however big the graph is. Queries are written as patterns in Cypher:

```cypher
MATCH (m:Material {key: "acacia"})<-[:BUYS {country: "LA"}]-(s:Supplier)-[:SUPPLIES]->(o:Order),
      p = (:Product {key: "roundwood"})-[:USED_TO_MAKE*1..4]->(:Product)<-[:OF_PRODUCT]-(o)
RETURN s.name, o.id, p
```

It also comes with graph algorithms (shortest paths, centrality, communities), graph pictures
(Bloom), and vector indexes next to the graph, which GraphRAG setups use.

**What we use instead, and why.** The graph is small (32 shared nodes, 25 links; a company has
tens of suppliers and orders), the walk is at most 4 links, and the company data it joins
(orders, suppliers, sourcing) already lives in Postgres with its company scoping, migrations and
backups. One recursive SQL query answers in milliseconds, with nothing to keep in sync.

**When to switch.** Any of these:
- Walks get deep or wide: many industries and many-to-many supplier networks (suppliers of
  suppliers), where recursive SQL gets slow or hard to write.
- We need graph algorithms: which supplier is most central to the company's risk, clusters of
  suppliers sharing origins.
- GraphRAG needs flexible pattern queries from the assistant, or graph and vector search in one
  store.
- People want to explore the graph visually.

**How we'd add it.** As a read model, not the source of truth: Postgres stays where data is
written; a sync job (or change events) copies nodes, links, sourcing and orders into Neo4j
(managed: AuraDB, on Google Cloud Marketplace), keyed per company. The walk and `query_graph`
then run Cypher there. Before Neo4j, Apache AGE (a graph extension inside Postgres, with Cypher)
is a smaller step to try. In the plan: after GraphRAG, only when one of the triggers above shows
up.

## 10. Where the code is

| Layer | Files |
| --- | --- |
| Tables | `database/models/knowledge_graph.py`, `news_order_reviews` in `database/models/news.py` |
| SQL (incl. the recursive walk) | `database/queries/knowledge_graph.py` |
| Walk, word matching, sourcing, feedback | `services/knowledge_graph.py`, `services/graph_words.py`, `services/supplier_sourcing.py`, `services/graph_feedback.py` |
| News watch, Material chain page | `services/news_matches.py` (`GET /news-matches`, `/news-matches/accuracy`), `services/material_chain.py` (`GET /knowledge-graph/chain`) |
| Loading | `seed_reference_data.py` (graph), `seed_demo_data.py` (sourcing) |
| Scan and eval | `ai/server/scan.js`, `ai/server/mentions.js`, `ai/server/eval/scan-*.js` |
| Screens | `frontend/ai/news/NewsOrders.tsx` (path), `frontend/src/trade-map/` (sourcing), `frontend/src/MaterialChain.tsx` |
| Tests | `tests/test_knowledge_graph.py`, `tests/test_suppliers_and_sites.py`, `tests/test_supplier_documents.py`, `ai/server/test/mentions.test.js`, `ai/server/test/scan-eval.test.js` |
