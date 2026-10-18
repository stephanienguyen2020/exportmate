# ExportMate - Your AI Trade Companion

🌏 Export compliance, news impact and next steps for small manufacturers

ExportMate answers three questions for every export order: **what changed, does it affect my order,
and what should I do next?** **Gemini** reads regulations, supplier documents and trade news; a team
of **Google ADK agents** on **Gemini Enterprise Agent Platform** answers questions with a cited source
for every fact; and a **knowledge graph** traces how a news story about a raw material reaches a
finished order. 

🔗 Live: [exportmate.vercel.app](https://exportmate.vercel.app). "Explore the demo" opens a sample
workspace in the browser with no account; signing in opens a company workspace.

**Try it** with the demo company, Binh Duong Wood Co. (a Vietnamese plywood and furniture exporter):
sign in at [exportmate.vercel.app/#/login](https://exportmate.vercel.app/#/login) with

| Email | Password |
|---|---|
| `lan@example.com` | `testinguser123@` |

It has 13 orders to the EU, Asia and the US, five suppliers with what each buys, the playbook, the
trade map, News watch and the assistant with the knowledge graph. Please don't change the password.

> All legal and regulatory content is illustrative, the demo's stock is synthetic, and the news is
> real. Alerts and answers are AI assessments, not legal advice.

---

## ✨ Features

### 📦 Orders and analysis

- **Import orders** from a CSV: every row is validated before import, and imported orders are analysed
  straight away.
- **Analysis report per order:** the order is checked against its destination market's checklist, the
  supplier's documents and the company's own playbook rules. The report lists each gap, the official
  text behind it and the estimated cost, and sets the order's status (in the clear, or action needed).
- **Next moves** on each report open the right fix in place: the order's HS code, destination or ship
  date, or the supplier's record.
- **HS code suggestions** for an order without one, from the company's past orders and the official
  tariff lines (vector search with **pgvector**).
- **Status by hand**, one order or many, with a required note; every change is kept as the order's
  history.

### 📜 Rules and regulations

- **Regulations:** official texts with their version history. **Gemini drafts a market's
  requirements** from the text, each line quoting its source, and the owner reviews them before they
  count.
- **Rule watch:** checklist lines that take effect or change in the next 90 days, in the markets of
  open orders.
- **Playbook:** the company's own **WHEN/THEN rules** (margins, documents, supplier deadlines), checked
  in every analysis.

### 🛠️ Acting on a gap

- **Suggested solutions:** Gemini writes a summary and steps for each gap from the report's facts, the
  cited text and the team's notes on earlier fixes; every number and link is checked against what it
  was given. Solutions are saved, reused for later orders and listed in the **Knowledge base**, and
  expire when the rule changes.
- **Supplier messages:** Gemini drafts an email asking the supplier for what's missing; the owner
  approves it, and it's sent once.
- **Reports:** order and company reports, editable, exported as PDF with every edit highlighted, and
  emailed.

### 🗺️ Suppliers and the trade map

- **Trade map:** destinations, suppliers, production sites and routes on a 3D globe.
- **What if:** compare another destination, ship date or transit hub, see which documents carry over
  and which requirements need another check, and save the comparison with a note. Gemini can start
  the note from a reading of the comparison.
- **Supplier certificates:** upload one and **Gemini reads it**: the number, issuer, expiry, and what
  the supplier buys (material, origin country, form), which becomes the supplier's sourcing.

### 📰 News watch

- **Daily news scan:** trade news from built-in and company-added feeds. Gemini reads each article and
  pulls out the goods it affects and what it names (materials, HS codes, origin countries, markets).
  **Model Armor** screens articles for prompt injection first.
- **Orders it may hit:** the **knowledge graph** finds the open orders an article reaches, with the path
  and a source on every link. The team confirms or rejects each match, and links people keep rejecting
  are avoided.

### 💬 The assistant

- Opens from every screen: ask about your orders, rules, news, stock, or how to use the app.
- **Ask about connections:** "what if Vietnam restricts acacia log exports?" or "which orders depend on
  acacia?" The assistant walks the knowledge graph and names each order with the path that reaches it
  (**GraphRAG**).
- Every fact carries a **numbered citation**; an auditor checks citations and figures, and a critic
  checks that each connection it claims matches its path, before the answer is shown.
- **Audit trail:** each answer's steps, the agent behind each one, the tools called, the evidence and
  the checks, live and saved.
- **Memory:** remembers a signed-in user's preferences and work; Account › What the assistant remembers
  lists them and forgets any on request.

### 👥 Team and accounts

- Sign-in with **Firebase Auth** (email or Google), company workspaces, invites, and owner, editor and
  viewer roles.
- An **activity log** of every change, exportable as CSV.
- **Browser demo:** the full workspace in the browser with sample orders, no account needed.

---

## 🤖 How It Uses AI Agents

The assistant is a multi-agent team built with **Google ADK** and running on **Agent Platform's Agent
Runtime**.

1. **Router**
   - Picks the model for each question: a **quick-answer agent** on a small Gemini model, or an
     **analyst** on a larger one. Connection questions ("depends on", "made from", "which orders",
     "restricts") go to the analyst.

2. **Specialists**
   - The analyst delegates to specialists, each with its own read-only tools: **company** (orders,
     checklists and playbook, read with the user's own token), **news** (alerts and scans), **stock**,
     **knowledge** (search over **RAG Engine**, then a BM25 rerank) and **graph** (`query_graph`, the
     knowledge graph's paths from material to order).

3. **Auditor**
   - Checks every draft: citations resolve, figures appear in what the tools returned, news carries its
     date, links are real sources, and every order the graph reached that the answer names cites its
     path. A failing draft goes back to the analyst once.

4. **Critic**
   - A Gemini check after the auditor: order by order, it compares what the answer says connects the
     order with its path and the order's own facts. An added supplier, country or step, or a
     contradiction, sends the draft back once; still failing, the answer is flagged for review.

5. **Sessions and Memory Bank**
   - Keep each chat's context and what a user asked the assistant to remember.

6. **Governance and evaluation**
   - The agents run as their own **Agent Identity**, call only endpoints listed in **Agent Registry**,
     and send their traffic through **Agent Gateway** with **Model Armor**.
   - A golden set of questions is scored after changes, also on **Agent Platform › Evaluation** with
     managed judges.

Gemini also works outside the chat, always with code checking its answer before it's saved: drafting
requirements from regulations, reading supplier certificates, assessing news, writing solutions,
drafting supplier emails, reading what-if comparisons, and building the material chain.

📖 How to use the AI features: [docs/AI_GUIDE.md](docs/AI_GUIDE.md). The harness around the agents
(policy, tools, guard, auditor, evals): [docs/AGENT_HARNESS.md](docs/AGENT_HARNESS.md).

---

## 🧩 The Knowledge Graph

News rarely names your order. A story about **acacia logs from Vietnam** never mentions plywood or
PO-2291, yet the order depends on it. The knowledge graph connects them.

- **Nodes:** materials (acacia, rubberwood), products (each an HS heading: logs, veneer, plywood,
  furniture), suppliers and orders.
- **Links:** a product is *used to make* another (each link quoting an official text), a supplier
  *buys* a material from a country in a form, a supplier *supplies* an order, and an order *is* a
  product through its HS code.

```
Binh Phu Wood ──BUYS (Vietnam, logs)──► acacia
logs ──USED_TO_MAKE──► veneer ──USED_TO_MAKE──► plywood
PO-2291 ──IS_PRODUCT──► plywood        Binh Phu Wood ──SUPPLIES──► PO-2291
```

The material chain covers **every commodity in the EU deforestation rule** (wood, cocoa, coffee, oil
palm, soya, rubber, cattle). It is built offline by a **Gemini writer** that proposes links with quotes
from official texts, **code checks** on each quote and HS code, and a **Gemini reviewer** that flags
doubtful links for a person.

**How the graph is used:**

- **Neo4j AuraDB** holds the graph as a read model: products, materials and chain links with their
  weights, and each company's suppliers (*buys*) and orders (*supplies*, *is*). **Cloud SQL Postgres**
  stays the source of truth.
- **The walk** runs as a **Cypher** query on Neo4j while its copy matches Postgres (a fingerprint of
  the chain), and falls back to a recursive SQL query otherwise. The query reports where it walked.
- **Ranking:** between paths of equal length, the walk prefers fewer doubted links, then fewer less
  common routes, then links with higher weights.
- **Learning from verdicts:** a nightly job counts every company's confirms and rejects per chain link
  into a weight. A link a company keeps rejecting is doubted for that company straight away.
- **Chain versions:** each industry's chain is versioned in Postgres. A new build arrives as a draft
  with what it changes and what the pipeline flagged; a **chain admin** reviews it on the Material
  chain page and publishes or rejects it. Publishing rebuilds the graph.

### 🚀 Architecture

![Knowledge graph and GraphRAG architecture by flow](docs/knowledge-graph-architecture.png)

#### 🩵 1. News watch

- **Cloud Scheduler** starts the news scan on **Cloud Run**; Gemini assesses each article and the alert
  is saved in **Firestore**.
- The **News matches API** reads the alerts, walks the graph on **Neo4j** for the orders each one
  reaches, returns them with their paths, and saves each verdict in Postgres.
- The **link weights job** (a Cloud Run job, started by Cloud Scheduler every night) turns verdicts
  into link weights.

#### 📘 2. Material chain builder (offline)

- The Gemini writer, code checks and Gemini reviewer turn official texts into links, each quoting its
  source.
- The result is saved as a draft **chain version**; a chain admin reviews the changes and flags, and
  publishes or rejects it.
- A **source finder agent** that collects new official texts into Cloud Storage is the next addition.

#### 🏭 3. Supplier sourcing

- An uploaded certificate is read by Gemini, the user confirms the suggestions, and they're saved as
  the supplier's sourcing: each one a *buys* link from the supplier to a material.

#### 🧠 4. Assistant (GraphRAG)

- The router sends a connection question to the analyst, which hands it to the **graph specialist**.
- Its `query_graph` call goes through **Agent Gateway** and **Model Armor** to the **Graph query API**
  on Cloud Run, which reads what the question names (materials, countries, HS codes, markets), walks
  the graph for the user's company with a **Cypher** query on **Neo4j AuraDB**, and returns each order
  with its cited path and what it did and didn't recognise.
- The answer cites each order's path and each link's official text. The **auditor** checks every
  order named cites its path, and the **critic** checks the claims match the paths.

#### 🗄️ Data

- **Cloud SQL Postgres** is the source of truth, one block per table.
- After each change (the chain, or a company's suppliers, sourcing or orders), an event goes to
  **Pub/Sub**; its push subscription calls the **graph sync** endpoint, which rewrites that part of
  **Neo4j** from Postgres. Failed syncs are retried, and deploys and the nightly job run a full sync.

---

## ☁️ Google Cloud

Everything runs in one project, defined in [`infra/terraform`](infra/terraform/).

| Service | What ExportMate uses it for |
| --- | --- |
| Gemini | the assistant's two model tiers, news assessment, regulation drafting, certificate reading, solutions, supplier emails, the material chain builder |
| Agent Platform: Agent Runtime, Sessions, Memory Bank | the ADK agents, each chat's session, per-user memories |
| Agent Platform: RAG Engine | search over stock, articles, alerts, sources and help guides |
| Agent Platform: Evaluation | golden-set runs scored by managed judges |
| Agent Identity, Agent Registry, Agent Gateway, Model Armor | the agents' identity, the endpoints they may call, their egress, prompt-injection screening |
| Cloud Run | the AI service (`exportmate-ai`), the backend (`exportmate-backend`, including the Graph query API and the graph sync endpoint), the link weights job, and a job for seeding, indexing, scans and evals |
| Cloud SQL (Postgres + pgvector) | company data, the trade map, regulations, the knowledge graph's source of truth and chain versions, HS code vectors |
| Pub/Sub | change events that keep Neo4j in step with Postgres (a push subscription to the graph sync endpoint) |
| Firestore | news, alerts, stock, chat audits, the answer cache |
| Cloud Storage | the files RAG Engine indexes, uploaded documents |
| Cloud Scheduler | the daily news scan and the nightly link weights job |
| Secret Manager | the Neo4j password and other credentials |
| Cloud Build, Artifact Registry | building and storing the images |
| Cloud Logging and Monitoring | JSON logs, log-based metrics, alerts and dashboards |

Outside Google Cloud: **Neo4j AuraDB** holds the graph read model, the frontend is a React app on
Vercel, and Firebase Auth signs people in.

---

## 📁 Repository

| Folder | What it is |
| --- | --- |
| [`frontend/`](frontend/) | React 19 + TypeScript + Vite app; the chat and News watch UI live in [`frontend/ai/`](frontend/ai/) |
| [`backend/`](backend/) | FastAPI + Postgres company API; see [`backend/README.md`](backend/README.md) |
| [`ai/server/`](ai/server/) | Node service: the ADK agents, News watch and search |
| [`infra/`](infra/) | Terraform, Agent Platform governance, monitoring |
| [`docs/`](docs/) | AI guide, agent harness, architecture diagrams |
