# News impact: a supplier graph, then ML severity (plan)

Two ideas from team feedback, planned together because they sit in the same flow. Not built. The news scan is in `ai/server` (see [AGENT_HARNESS.md](AGENT_HARNESS.md)); order matching is in the backend (`backend/app/services/news_matches.py`).

- **Phase 1: a graph from news to suppliers and orders.** Find the orders an article hits by following connections (supplier → material → country), not only by comparing HS codes.
- **Phase 2: severity from a trained model.** A model trained on labelled examples picks the severity instead of Gemini's judgment. Overview here; design and data in [`ml/`](../ml/README.md).

## 1. Where they sit in the app

Today:

```
Daily news scan (AI service, ai/server/scan.js)
  1. Read articles from the news feeds
  2. Gemini: which stock items it affects, and a severity (high / medium / low)   ← phase 2
  3. Save an alert (Firestore)
        │
        ▼
Backend: which orders may it affect? (services/news_matches.py)
  4. Rule: same HS heading (first 4 digits) + same market                          ← phase 1
  5. An editor confirms or rejects each suggested order (news_order_reviews)
        │
        ▼
News watch screen, company report, Rule watch
```

## 2. Phase 1: a graph from news to suppliers and orders

### Why the HS rule misses orders
The demo's PO-2291 and PO-2304 are both **acacia plywood, HS 4412.33**, from Binh Phu Wood to the EU (`frontend/src/data.ts`). Suppose the scan reads "Laos bans exports of acacia logs" (an example article). Logs are **HS 4403**, plywood **4412**, wooden furniture **9403**: the same wood has a different code at each step from forest to product.

Today's rule compares the first 4 digits of the code the alert names with the order's: 4403 ≠ 4412, so neither order is suggested, even though Binh Phu Wood's plywood may be made from those logs. HS codes describe **what the product is**, not **what it is made of or where its material comes from**. Following those links is what the graph adds.

### What a knowledge graph is
A list of **things** (nodes) and **connections** between them (edges), stored so a program can walk from one thing to another.

```
Article: "Laos bans exports of acacia logs"
   │ mentions
   ├── country: Laos
   └── material: acacia logs (HS 4403)
            │ used to make
            └── acacia plywood (HS 4412)
            │ sourced by
            └── Binh Phu Wood (sources acacia from Laos)
                     │ supplies
                     ├── PO-2291 acacia plywood → EU
                     └── PO-2304 acacia plywood → EU
```

"Which orders does this article hit?" becomes "walk from the article along the edges until you reach orders". The walk itself is the explanation shown to Lan: *"May affect PO-2291 and PO-2304: their supplier Binh Phu Wood sources acacia from Laos."* That fits the rule that every claim has a source.

### Nodes and edges

| Node | Edge | Where it comes from |
| --- | --- | --- |
| Article | *mentions* country, material, HS code, regulation | The news scan: AI extracts them; code keeps only ones on our lists (countries, `hs_headings`, regulations) |
| Material / HS code | *used to make* another HS code (logs → sawn wood → plywood → furniture) | A small seeded list per industry (the "material chain") |
| Supplier | *sources* material *from* country | **New data:** the supplier form (material + country of origin), or AI reading supplier documents (already built) |
| Supplier | *supplies* order | Already there: orders name their supplier |
| Order | *ships to* market, *has* HS code | Already there |
| Regulation / market requirement | *applies to* market + HS prefix | Already there |

### Where the material chain comes from
There is **no public dataset of "HS code A is made from HS code B"**. We build the list ourselves, from official anchors, and every link cites where it came from (like market requirements cite a regulation).

| Source | What it gives | Use |
| --- | --- | --- |
| **EUDR Annex I**: Regulation (EU) 2023/1115, already in `backend/app/seed_data/regulation_sources.json`; overviews [Prewave](https://help.prewave.com/en/articles/310638-eudr-relevant-hs-codes-based-on-annex-i), [Coolset](https://www.coolset.com/academy/which-products-are-covered-under-the-eudr-sector-by-sector-overview) | For 7 commodities (wood, cocoa, coffee, oil palm, rubber, soya, cattle), the HS codes of every product made from them, e.g. wood → 4401–4421, 47, 48, 9401, 9403 | **Start here.** Official, citable, covers our demo industries. Gives "commodity → products", not every step in between |
| **The HS structure itself**: [USITC HTS](https://hts.usitc.gov/), already seeded as `hs_headings` (6,573 headings) | Chapters run from raw to processed: 4403 logs → 4407 sawn wood → 4408 veneer → 4412 plywood; 94 furniture | The steps inside a chain, by hand for each industry we support |
| **FAO forest product classification (JFSQ)**: [definitions PDF](https://fao.org/forestry-fao/35789-0902b3c041384fd87f2451da2bb9237.pdf) | Roundwood, then first processing (sawnwood, veneer, pulp), then further processing (panels, paper), with HS cross-references | Checks the wood chain's order |
| **UN Broad Economic Categories (BEC Rev.5)**: [manual](https://unstats.un.org/unsd/trade/classifications/Manual%20of%20the%20Fifth%20Revision%20of%20the%20BEC%20(Edited)-%20EN.pdf); HS ↔ BEC/NAICS/BEA tables in the R [`concordance`](https://insongkim.r-universe.dev/concordance) package | Each HS code's stage: primary, processed, final | Orders a chain for a new industry; doesn't say what links to what |
| **Input–output tables**: [US BEA](https://www.bea.gov/industry/input-output-accounts-data); on an HS basis in the [Conconi appendix](https://conconi.ulb.be/Appendix_RoO.pdf) | Which industries buy from which (the plywood industry buys logs) | Later, to suggest links for many industries at once. Coarse: one industry code covers about 14 HS codes |
| **US Customs rulings (CROSS)**: [rulings.cbp.gov](https://rulings.cbp.gov/); used in the [ATLAS paper](https://arxiv.org/pdf/2509.18400) | Product descriptions → 10-digit HS codes | Not chain links: maps a supplier's free-text products to HS codes (and helps HS suggestions) |

**Seed data:** [`backend/app/knowledge_graph/`](../backend/app/knowledge_graph/README.md) (EUDR Annex I parsed, the wood chain, materials); suppliers' `sourcing` is in the company seeds.

**How we make the list:** for each industry we support, start from the EUDR Annex I (or the HS chapters), write the chain by hand or let AI draft it from these sources, and have a person review it. These seeded links are also the first "labels" the graph is tested against. A new industry starts with AI drafts and a person's review.

### How it works
1. When an alert arrives, take the article's nodes (countries, materials, HS codes).
2. Walk at most 3–4 edges: material → products made from it → suppliers that source it (from that country) → their open orders.
3. Each order reached becomes a suggestion, with the path as its reason, next to today's HS-heading suggestions.
4. An editor confirms or rejects it on News watch (the screen exists). Rejections show which edges are wrong (e.g. the supplier stopped buying from Laos).

### How to build it
1. **Supplier sourcing data:** add "materials and their origin countries" to suppliers (the form and the seed). Without it the graph has nothing to follow; today there is only free text ("Acacia plywood, outdoor furniture, cabinets").
2. **Material chain:** a seeded table of "HS code A is used to make HS code B" for our industries (start with wood: 4403 → 4407 → 4412 → 9403).
3. **Entity extraction in the scan:** Gemini returns the countries, materials and HS codes an article names (fixed schema); code keeps only known ones.
4. **An `entity_links` table in Postgres** (from, relation, to, source, confidence), next to orders and suppliers; walked with a recursive SQL query. A separate graph database (Neo4j) only if the graph grows large or for graph pictures.
5. **Matching:** `news_matches.py` adds graph suggestions, with their path, to the HS-heading ones.

### Workflow

```
News scan:  article → AI extracts countries / materials / HS codes → code checks them
            → edges "article mentions X"
Backend:    alert arrives → walk the graph → orders reached + the path
            → suggestions on News watch → editor confirms / rejects
```

### Where an LLM is used
Only at the edges. Gemini turns article text into graph inputs (countries, materials, HS codes; code keeps only known ones), and AI can suggest supplier sourcing from documents or draft a new industry's chain for a person to review. The walk from article to orders is SQL in code: same input, same answer, every path citable. The explanation is the path in a template, not generated text.

### Later: GraphRAG in the assistant
After phase 1 (it needs the graph and the walk). GraphRAG = for a question, fetch the relevant part of the graph (nodes and paths) and give it to Gemini as context, next to or instead of text chunks. Today the assistant uses plain RAG (RAG Engine finds similar text chunks), which can't follow connections across records.

| Question in the chat | Plain RAG today | With GraphRAG |
| --- | --- | --- |
| "Which of my orders depend on wood from Laos?" | Finds articles naming Laos, can't connect them to orders | Walks country → material → supplier → orders; the paths are the citations |
| "If Vietnam restricts acacia log exports, what's exposed?" | Guesses from similar text | The same walk as a what-if: suppliers, orders, value at risk |
| "Why was PO-2291 flagged by this article?" | Repeats the alert | Shows the path and the FAO / EUDR quotes behind each link |
| "Which suppliers have no sourcing data?" | Can't answer | Suppliers with no sourcing edges |

**How it fits:** one more read-only tool for the assistant's agents (`query_graph`, scope `orders`), calling a backend endpoint that runs phase 1's walk with the user's token. The agent gets paths; the auditor (`review.js`) checks the answer cites them, as it does for `query_orders`. The graph stays the source of truth; Gemini only explains what the walk returned.

**Other later uses:** the company report's "news → orders" section built from paths and summarised by Gemini; suggested solutions given the path so steps target the right link ("ask Binh Phu Wood for a non-Laos source"); phase 2's "orders hit" and their value come from the same walk.

**Not for:** deciding which orders an article hits. That stays deterministic SQL.

## 3. Phase 2: severity from a trained model (overview)

Design, data and model choice: [`ml/SEVERITY_MODEL.md`](../ml/SEVERITY_MODEL.md). Data sources and downloaded files: [`ml/README.md`](../ml/README.md).

### Use case
The scan reads "Laos bans exports of acacia logs from 1 December". Today Gemini reads it and the rules in its prompt ("high = likely cost or market-access change within ~90 days…") and answers "high". With this phase, a small model trained on labelled examples gives the level and how sure it is; Gemini only writes the explanation. Same article, same level, every time, and we can measure how often it's right.

### In short
- **Output:** `low` / `medium` / `high` plus a confidence. Below a threshold the alert is marked "needs a person" instead of guessing.
- **Severity has two parts:** how bad the measure is (a model learns this from public data, e.g. Global Trade Alert) and how much it touches this company (code computes it, using phase 1's "orders hit" and their value).
- **Labels:** public ratings are an input, not the answer: GTA's red/green means "harms / opens trade", not "matters to our exporter". We need our own labels, from people's verdicts on News watch and a few hundred measures rated by hand.
- **Models:** compare rules, logistic regression, gradient boosting and Gemini on the same test set; keep the simplest one that beats Gemini on catching `high` alerts.
- **Where it runs:** trained offline on a laptop first, later on Vertex AI; the scan loads the chosen model and records which version decided.

## 4. How the two connect, and the order to build them

```
article ─► graph: which orders it hits, and how          (phase 1)
        └► model: how serious it is for this company     (phase 2; "orders hit" and their value are features)
                     │
                     ▼
        person confirms on News watch ──► verdicts become labels for the model
```

1. **Now:** start storing verdicts (severity right/wrong, order confirmed/rejected).
2. **Phase 1:** it closes a real gap (news reaching the company's orders through its suppliers), and its "orders hit" feeds phase 2.
3. **Phase 2:** once there are a few hundred labels plus public data; run next to Gemini before switching.

## 5. Open questions
- Who keeps the material chain up to date for each industry (seeded per industry like the checklists, or AI-suggested and reviewed).
- Whether suppliers' sourcing countries come from the user or from their documents (certificates of origin, legality documents name them).
- Global Trade Alert's licence for training a model in a commercial product.
- Both mostly change the AI service's news scan (`ai/server`): agree with its owner on the extraction schema and where the model runs.
