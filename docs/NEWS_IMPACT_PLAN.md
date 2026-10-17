# News impact: a supplier graph, then ML severity (plan)

Two ideas from team feedback, planned together because they sit in the same flow. Phase 1 is built (technical details in [`backend/app/knowledge_graph/README.md`](../backend/app/knowledge_graph/README.md)); phase 2 is planned (design in [`ml/`](../ml/README.md)).

- **Phase 1: a graph from news to suppliers and orders.** Find the orders an article hits by following connections (supplier → material → country), not only by comparing HS codes.
- **Phase 2: severity from a trained model.** A model trained on labelled examples picks the severity instead of Gemini's judgment. Overview here; design and data in [`ml/`](../ml/README.md).

## 1. Where they sit in the app

```
Daily news scan (AI service)
  1. Read articles from the news feeds
  2. Gemini: which goods it affects, what it names, and a severity    ← phase 2: severity
  3. Save an alert
        │
        ▼
Backend: which orders may it affect?
  4. Walk the knowledge graph (and the HS heading rule)                ← phase 1
  5. A person confirms or rejects each suggested order
        │
        ▼
News watch screen, company report, Rule watch
```

## 2. Phase 1: a graph from news to suppliers and orders

Built and deployed for testing (16 Oct 2026). How it works, the data, the status and the next
steps: [`backend/app/knowledge_graph/README.md`](../backend/app/knowledge_graph/README.md).

### Why the HS rule missed orders
The demo's PO-2291 and PO-2304 are both **acacia plywood, HS 4412.33**, from Binh Phu Wood to the EU. Suppose the scan reads "Laos bans exports of acacia logs". Logs are **HS 4403**, plywood **4412**, wooden furniture **9403**: the same wood has a different code at each step from forest to product. Comparing the first 4 digits (4403 ≠ 4412) suggests neither order, even though Binh Phu Wood's plywood may be made from those logs. HS codes say **what a product is**, not **what it is made of or where its material comes from**. Following those links is what the graph adds.

### What a knowledge graph is
A list of **things** (nodes) and **connections** between them (edges), stored so a program can walk from one thing to another.

```
Article: "Laos bans exports of acacia logs"
   │ names
   ├── country: Laos
   └── material: acacia logs (HS 4403)
            │ used to make → veneer → plywood (HS 4412)
            │ bought by
            └── Binh Phu Wood (buys acacia from Laos)
                     │ supplies
                     ├── PO-2291 acacia plywood → EU
                     └── PO-2304 acacia plywood → EU
```

"Which orders does this article hit?" becomes "walk from the article along the links until you reach orders". The walk is the explanation shown to the user: *"Binh Phu Wood buys acacia from Laos; logs → veneer → plywood, this order's product"*, each link citing its source (FAO definitions, EUDR, HS headings). That fits the rule that every claim has a source.

### What the user gets
- **News watch:** orders an article may affect, found through their suppliers and the material chain, with the path under each one. People confirm or reject, as before.
- **Trade map:** each supplier's "Materials it buys" (material, country, form), typed in or ticked from what AI read on an uploaded certificate. Without it, news reaches a supplier's orders only by HS heading.
- **Measured:** verdicts record how each suggestion was found, so we can see how often the graph is right and which links are wrong.

### Decisions
- **AI only at the edges.** Gemini reads what an article and a certificate name; the walk from article to orders is code, so the same news gives the same answer and every path is citable.
- **We keep the shared chain correct, not each company.** No per-company switch for each link: a company's own suppliers and orders decide which part of the graph matters to it. Companies give feedback by rejecting suggestions; links that keep being rejected lose weight automatically.
- **Postgres first.** A graph database (Neo4j) only if the walk outgrows it: much bigger supplier networks, graph algorithms, or the assistant's graph questions need it.

### Later
1. **More industries** (coffee, cocoa, textiles): an offline pipeline where one AI writes chain links from official texts and another reviews them, and we check what they flag.
2. **GraphRAG in the assistant:** answer questions about connections from the graph.

   | Question in the chat | Plain RAG today | With GraphRAG |
   | --- | --- | --- |
   | "Which of my orders depend on wood from Laos?" | Finds articles naming Laos, can't connect them to orders | Walks country → material → supplier → orders; the paths are the citations |
   | "If Vietnam restricts acacia log exports, what's exposed?" | Guesses from similar text | The same walk as a what-if: suppliers, orders, value at risk |
   | "Why was PO-2291 flagged by this article?" | Repeats the alert | Shows the path and the quotes behind each link |
   | "Which suppliers have no sourcing data?" | Can't answer | Suppliers with no sourcing |
3. **A graph database (Neo4j)**, after GraphRAG and only when needed (see the README).
4. The company report and suggested solutions use the paths too; phase 2 uses "orders hit" and their value.

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

1. **Phase 1 (built):** news reaches the company's orders through its suppliers; verdicts are stored with how each suggestion was found.
2. **Next:** a "severity right/wrong" verdict on News watch, so phase 2 gets labels.
3. **Phase 2:** once there are a few hundred labels plus public data; run next to Gemini before switching.

## 5. Open questions
- When to build the offline pipeline for new industries, and the confidence a link needs before it makes suggestions.
- Global Trade Alert's licence for training a model in a commercial product.
- Both mostly change the AI service's news scan (`ai/server`): agree with its owner on the extraction schema and where the model runs.
