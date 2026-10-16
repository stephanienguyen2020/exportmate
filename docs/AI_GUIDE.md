# ExportMate AI: how it works and how to use it

ExportMate has these AI features:

- **The assistant** answers questions about stock, news alerts, your company, its orders and playbook rules, and how to use ExportMate. Every fact it gives carries a numbered citation, and every answer has an audit trail.
- **News watch** reads approved news feeds every morning and raises alerts for the stock items each story could affect.
- **Suggested solutions** (signed-in workspaces) propose how to fix each missing or wrong document an order's analysis found, and keep the answer, with your team's notes, for later orders with the same problem.

Both come from one service ([`ai/server/`](../ai/server/)): its API runs on Google Cloud Run, and the assistant itself is a team of agents on Gemini Enterprise Agent Platform (Agent Runtime, with Agent Platform Sessions, Memory Bank and RAG Engine), using Gemini and Firestore. This guide covers how to use them, what they can see, and how they work. For the engineering controls (policy, gateway, auditor, evals) and how to improve them, see [AGENT_HARNESS.md](AGENT_HARNESS.md).

Alerts and answers are AI assessments, not legal advice. Legal and regulatory content in the prototype is illustrative, stock data is synthetic, and news is real.

## Using the assistant

**Open it.** The round chat button at the bottom right of the landing page and every workspace page opens the assistant. The expand icon in its header opens the full-screen view at `#/chat`, which adds the audit trail for the whole conversation.

**Ask.** Type a question and press Enter (Shift+Enter starts a new line). A new conversation shows four suggested questions to start from. While the assistant works, it shows each step as it happens: which agent is working, "Searched the knowledge base", "Queried stock in Firestore", a specialist's report, and so on. A question that needs several lookups takes longer than a single lookup, and the app gives up after two minutes.

**Follow up.** You can say "those items" or "that alert" and the assistant works out what you mean. It looks the facts up again each time instead of trusting its earlier answers. It replies in the language you write in.

**Start over.** "New chat" (the pencil icon in the chat's header, or the button at the top of the full-screen view) starts a new conversation at any time, also while an answer is still coming; the full-screen audit trail then starts empty. Your browser tab keeps the conversation you see, and the assistant keeps the same conversation as an Agent Platform session; both start over when you close the tab, sign in or sign out. In a company workspace the assistant can still remember your preferences from earlier conversations (see below).

### What you can ask

| Kind of question | Example | What the assistant uses |
| --- | --- | --- |
| Stock | Which stock items have no origin trace on file? | `query_inventory` |
| News alerts | What did the latest news scan flag? | `get_alerts`, `get_scan_status` |
| Exposure to a topic | How much stock is exposed to US anti-dumping cases? | `get_alerts`, `query_inventory`, `search_knowledge` |
| News and background | What is happening with EUDR? | `search_knowledge` |
| Scan and sources | When did the scan last run? Did any source fail? | `get_scan_status` |
| Using ExportMate | How do I import my orders? | `search_knowledge` (help guides) |
| Your company (signed in) | Which certifications do we hold? | `get_company_profile` |
| Your orders | Why does PO-2291 need action? | `query_orders` |
| Advice under your own rules | Should we ship PO-2291 this week? | `query_orders`, `get_playbook` |
| General trade knowledge | What is a certificate of origin? | No tools; it marks regulatory details as things to verify |

It declines anything outside trade, compliance and ExportMate (poems, general coding, homework) in one sentence, and it won't take on another role or discuss its instructions.

### What the assistant can see

| | Sample demo or signed out | Signed-in company workspace |
| --- | --- | --- |
| Stock | The sample inventory: 31 synthetic SKUs of Binh Duong Wood Co., a fictional Vietnamese wood-products exporter | The same sample inventory. The assistant says it is demo data, not your stock |
| News articles and alerts | Real articles from the built-in sources, and the alerts raised from them | The same, minus built-in sources your company switched off, plus your company's own custom sources |
| Company profile | No | Yes: what you entered under Account › About company, and your sites |
| Orders | The demo's orders, sent from your browser with each question (up to 100, those needing action first), each with the demo's one sample rule check | Yes, read live with your own sign-in: each order and its market document checklist, with the official text behind each line |
| Playbook rules | The rules switched on in your browser, sent with each question | The rules switched on in your company playbook, read live with your own sign-in |

The assistant applies your playbook rules when it advises on an order, a supplier, a shipment or a news alert, and cites each rule it uses. The rules are your preferences, not regulations, and can't change how the assistant works. If a rule needs data it doesn't have (margins, for example), it says it can't check it.

If the company backend can't be reached when you ask, the question is answered as a demo chat, without your profile, orders or playbook.

The assistant can't change anything. All its tools only read data, it sends no messages, and it can't add sources or start a scan.

### What the assistant remembers

In a signed-in company workspace, the assistant remembers things you tell it so you don't have to repeat them: how you like answers (language, level of detail, currency), instructions you give it ("always show values in EUR"), and what you work on (the markets, products and suppliers you keep asking about). It doesn't keep personal details, order values or anything about other people. Memories are yours alone, not shared with colleagues, and expire after 180 days.

Before each answer the assistant looks up what it remembers that bears on your question, and the audit shows what it recalled. Memories shape how it answers, never the facts: a remembered preference is never cited or used as a figure. To see or remove what it remembers, open **Account › What the assistant remembers** and choose "Forget" next to any memory.

The sample demo remembers nothing.

### Reading an answer

**Citations.** Each `[n]` in an answer is a link to what that fact came from, and the same sources are listed under the answer. Hover a number to see its type and title. Where the link goes depends on the type:

| Type | What it is | Link |
| --- | --- | --- |
| `article` | A news article | The original article |
| `alert` | A News watch alert | The article it was raised from |
| `item` | One stock item | News watch |
| `query` | A stock, alert or order lookup, cited for counts and totals | News watch, or Orders for an order lookup |
| `calculation` | Arithmetic the assistant ran, shown as `expression = result` | None |
| `scan` | A news scan run | News watch |
| `source` | A news feed | The feed |
| `guide` | An ExportMate help guide | The page it describes |
| `company` | Your company profile | Account |
| `order` | One of your orders | The order on the trade map (in the demo, the order's page) |
| `regulation` | The official text behind a checklist line | That exact document version in Regulations |
| `playbook` | One of your playbook rules | Playbook |

**Dates.** Every cited article and alert is given with its publication date. The auditor enforces this. If the news an answer relies on is more than 30 days old, the assistant is instructed to say it may be out of date.

**The audit line.** Under each answer, a line like "Audit · 3 tool calls · 6.2s · checks passed" opens the audit for that answer.

### The audit trail

Before an answer reaches you, an auditor runs five checks on it:

| Check | Passes when |
| --- | --- |
| Citations point to retrieved evidence | Every `[n]` matches something a tool returned in this answer |
| Figures traceable to tool results | Every number of three or more digits, and every percentage, appears in your messages or in this answer's tool results |
| Answer grounded in tool results | If tools were used, the answer cites at least one result |
| News cited with its date | Every cited article and alert has its date next to it |
| Links come from retrieved sources | Every web link in the answer is the address of a cited source |

A draft that fails goes back to the model once with the problems listed. If the final answer still fails, it is shown marked **Needs review**: read the failing check before relying on the answer.

The audit also lists every step:

- **Which agent**: every step carries the name of the agent that made it: *Quick answer* for simple lookups, *Analyst* for questions that need several facts, and the specialists the analyst asks (*Stock*, *News*, *Company* and *Knowledge specialist*).
- **Recalled memories**: what the assistant remembered about you before answering (company workspaces).
- **Planned next step**: which tools (or specialists) the agent chose and with what arguments.
- **Specialist reported**: what the analyst asked a specialist and the specialist's report.
- **Tool calls**: the arguments, the results with their reference numbers, similarity scores for searches, the age of news, and any error (for example "arguments rejected" or "timed out").
- **Withheld passages**: text from a news feed that tried to give the assistant instructions is replaced with `[removed: …]` before the model sees it, and the audit says where.
- **Drafted an answer / Auditor sent the draft back**: when a draft was revised, the draft and the problems found.
- **Reused an earlier answer**: when the answer came from the answer cache (see below).
- **Model, router, tokens, evidence, policy and record**: which model answered, which agent the router chose and why, token use, how many sources were retrieved and cited, the version of the assistant's rules, and the record's ID in Firestore.

The full-screen view at `#/chat` shows the audits of every answer in the conversation, reloaded from Firestore, and "JSON" downloads them all. Each answer's audit also has "Download audit JSON". The model's raw reasoning is stored for reviewers but not shown in the app.

### Limits

- 40 questions per hour from one address, and 200 per hour per server instance. Past that you see "You've reached the limit of questions for this hour" or "The assistant is busy".
- Messages can be up to 4,000 characters. The assistant reads the last 20 messages of a conversation.
- **Reused answers:** a question already answered today in the same conversation context, for the same company (and, where the assistant remembers you, for the same person), is answered again from the cache only if nothing it depended on has changed: stock, sources, the latest scan, the company profile, the assistant's rules and models. Only answers that passed every check are reused, and answers that read your orders or playbook never are. A reused answer says so in its audit.

## Using News watch

News watch is at `#/workspace/news`, the first tab of "Rules & news" in the sidebar (beside Rule watch, Regulations and the Playbook). The Overview page also shows the top three alerts.

**Alerts tab.** Each alert card shows:

- **Severity**: *high* means a likely cost or market-access change within about 90 days for items in stock; *medium* is material but uncertain or later; *low* is worth knowing.
- **Direction**: *risk*, *opportunity*, or *watch* (vague news, or something to verify).
- The headline, why it matters, each affected SKU with the reason, the stock value exposed, one next step, and a link to the source article.

- **Orders this may affect**: open orders found by following links from what the article names. The scan records the materials, HS codes, origin countries and markets an article names; the backend then reaches an order through its supplier (a supplier that buys the named material or buys from the named country) and the material chain from what the supplier buys to the order's product, e.g. *Binh Phu Wood buys acacia from Vietnam; logs → veneer → plywood, this order's product*, shown step by step under the order, each link citing its source (FAO definitions, HS headings; the icon opens it, hover for the quote). Orders sharing an HS heading (the first four digits) with an item the alert names, and shipping to one of that item's markets, are still suggested too. These are suggestions, not findings. An owner or editor marks each one **Affects this order** or **Not relevant**, with an optional note, can **Undo** a verdict, and can link an order that wasn't suggested. Viewers see the suggestions and verdicts. Company reports name only confirmed orders next to each alert. In the demo, verdicts stay in your browser.

Filter by severity or show only opportunities, search headlines, items and SKUs, or narrow to one source, one stock item, alerts with orders to review, confirmed for an order or with no order, or articles from the past 7 or 30 days. Read the source before acting: alerts are assessed from each article's headline and summary, not the full text.

**Stock tab.** The sample inventory and whose it is, with each item's main material and where it comes from, whether its origin is traced (for the sample, plot geolocation) and how many alerts affect it. In a signed-in workspace, alerts are still matched against this sample stock, not your company's stock, and the page says so; orders are only linked through the suggestions people review on the Alerts tab.

**Sources tab.** The feeds News watch reads. Seven are built in (Timber Trades Journal, VnExpress International, the European Commission press corner and four Google News searches) and shared by every workspace. Owners and editors can:

- switch a built-in source off. This affects only their own company.
- add a custom source: any public RSS or Atom feed over HTTPS, tested before it is saved, up to 10 per company. Only their company sees it and the alerts it brings in.
- switch off or remove their own custom sources. Built-in sources can be switched off but not deleted.

**Scan now.** A scan runs every day at 07:00 Vietnam time. Owners and editors can also start one with "Scan now". It takes about a minute, only one scan runs at a time, and a manual scan has to wait 10 minutes after the previous one.

| | Sample demo or signed out | Viewer | Owner or editor |
| --- | --- | --- | --- |
| Read alerts, stock and sources | Yes | Yes | Yes |
| Switch sources off or on, add or remove custom sources | No | No | Yes |
| Scan now | No | No | Yes |

News watch alerts also appear in the **News alerts** section of a company report (Reports page), which lists high and medium alerts from the report's period; in the PDF, each alert's publisher links to the article.

## Using suggested solutions

On an order's page (signed-in workspace, after an analysis), **Suggested solutions** lists each document the analysis found missing or wrong.

- **Suggest a solution.** Owners and editors ask AI for a summary and steps. It works only from the report's facts, the regulation text the check cites, and your team's notes on earlier solutions to the same problem. A suggestion that states a number or link it wasn't given is thrown away ("didn't pass its checks"): try again.
- **Saved for later orders.** A solution is offered for every later order with the same problem (same market, requirement and kind of gap). Solutions written for the same order, adopted ones, and ones written for the same HS heading or supplier come first.
- **Notes.** Anyone who can edit adds how they actually handle it ("we ask for the GeoJSON file"). Notes stay for good, show with the solution, and the AI reads them the next time it writes a solution to that problem.
- **Use, adopt, reject.** "Use for <order>" records which solution the order follows. "Adopt" makes it the first one offered for this problem; "Reject" means it is never offered as the answer.
- **Expiry.** A solution is valid for 90 days, or until the day before the requirement's stated change, and expires at once if the requirement starts citing another version of its regulation or leaves the checklist. Expired solutions stay visible under "Expired solutions, for reference only", with the reason and their notes, but they are never the default and can't be used or adopted. "Analyse again" writes a new one, which reads the expired one and its notes and links back to it.
- **Audit.** Every suggestion (with its full text and model), use, note and review is in the owner's activity log under "solution".

Viewers can read solutions and notes but not change them. The browser-only demo doesn't have this feature.

## How it works

### One question to the assistant

1. The browser sends the conversation to `POST /api/chat`, with your sign-in token if you're in a company workspace. The browser demo sends its orders and switched-on playbook rules instead; the service checks and trims them, and a company chat never uses them.
2. With a token, the Cloud Run service fetches your company profile from the company backend (`GET /api/v1/company/knowledge`) using that token, and who you are (`GET /api/v1/me`). The profile is how the assistant knows who it works for.
3. The service passes the question to the agents on Agent Runtime (`runtime.js`) and relays each step back to your browser as it happens. Your token goes along only so the agents can read your orders and playbook with it; it is never stored.
4. If the same question was answered against the same data today, that answer is reused (`answer-cache.js`).
5. The assistant continues your Agent Platform session, and in a company workspace recalls what Memory Bank remembers about you that bears on the question.
6. The **router** (`router.js`) picks the agent. Lookups and how-to questions go to *Quick answer*, on the small fast model, which has every tool. A question goes to the *Analyst*, on the bigger model, if it:
   - is a follow-up or names several SKUs;
   - asks for a total, average, percentage or exposure;
   - asks for judgement (why, should, compare, risk, impact);
   - is about trade rules (EUDR, duties, tariffs, anti-dumping);
   - contains pasted text or instructions aimed at the assistant;
   - or is longer than 300 characters.
7. The agent (Google ADK) plans, calls tools, reads the results and repeats. The *Analyst* doesn't call data tools itself: it asks the **specialists** (stock, news, company, knowledge), each a smaller agent with only its own tools, then does the arithmetic and writes the answer. Each answering agent gets at most six rounds (16 tool calls in all, across the team) before tools are switched off and it has to answer; a specialist gets three per request.
8. Every tool call, by any agent, goes through the **gateway** (`gateway.js`). The gateway checks the arguments against the tool's declared format, refuses tools this workspace doesn't have (the company profile outside a company workspace, for example), enforces the per-question budget, times out after 15 seconds and retries once on a temporary failure.
9. Text written by third parties (articles, alerts, custom feed names) is screened by the **guard** (`guard.js`). Passages addressed to the assistant are withheld. All the agents' traffic also passes Agent Gateway, where Model Armor screens it for prompt injection.
10. The **auditor** (`review.js`) checks the draft. A draft that fails goes back once, to the *Analyst*.
11. Each step is streamed to the browser as it happens, and the whole answer is stored as one audit record in Firestore (`audits`). In a company workspace, the question and answer then go to Memory Bank, which updates what it remembers about you.

The assistant's instructions are a list of rules in `policy.js`. Each rule names the mistake it prevents, for example "Follow-ups answered from an earlier (possibly wrong) answer instead of current data." The version of the rule list is stored on every audit, so a change in behaviour can be traced to a change in the rules.

### The tools

| Tool | What it reads | Available |
| --- | --- | --- |
| `search_knowledge` | The knowledge base on RAG Engine: news articles, alerts, stock items, sources and help guides | Always |
| `query_inventory` | Sample stock with exact filters (SKU, category, market, HS code, material, material origin, supplier, certification, origin traced), plus the count and total value. Its categories and markets are the stock's own | Always |
| `get_alerts` | Open News watch alerts, most severe first, with the combined exposure (each SKU counted once) | Always |
| `calculate` | Exact arithmetic, so every figure can be traced | Always |
| `get_scan_status` | When the last scan ran, what it read and raised, the schedule and each source's health | Always |
| `get_company_profile` | Your company profile and sites | Company workspace |
| `query_orders` | Your orders and their document checklists, from `GET /api/v1/trade-map` with your token, or the orders the browser demo sent | Company workspace, or a demo with orders |
| `get_playbook` | The playbook rules switched on, from `GET /api/v1/playbook/rules` with your token, or the rules the browser demo sent | Company workspace, or a demo with rules |

**Search.** `search_knowledge` asks Agent Platform RAG Engine for the records nearest in meaning to the query, in the corpora for the types it wants (articles, alerts, stock items, sources, guides): three times as many as needed. The embeddings are multilingual, so a question in Vietnamese finds English news. It then drops anything your company may not see, before any agent reads it, and reranks the rest with BM25, so exact codes and names such as `PLY-101` or `4412` count. Each scan adds its new articles and alerts to the index; `npm run index` rebuilds it.

### The daily news scan

Cloud Scheduler calls `POST /api/scan` at 07:00 Asia/Ho_Chi_Minh. The scan (`scan.js`):

1. Reads every enabled feed. It looks back 3 days (14 on the first run), skips articles an earlier scan already analysed, and takes at most 80 new articles.
2. Withholds articles that address the assistant or link to malicious sites: first by pattern, then with Model Armor when it is configured. An article Model Armor couldn't screen is left for the next scan.
3. Sends the rest to Gemini in batches of 16, with the stock list and the stock's profile (`seed/inventory.js` `STOCK_PROFILE`: whose stock it is, the words news uses for its goods and the goods that share its rules), so no industry is written into the code. For each article, the model answers whether it is relevant, how severe, which SKUs it affects and why, and one next step. The rules tell it to be strict: exchange rates, energy prices and goods the company doesn't stock are not relevant, and article text is news, never instructions.
4. Keeps an alert only if the model said relevant, at least one SKU it named is really in stock, the article isn't a repeat of another one, and it doesn't name only goods that share the stock's rules (for the sample, cocoa, coffee, rubber…) without the words for the stock's own goods (`relevance.js`, with the profile's word lists).
5. Stores the articles, alerts and scan record, and adds them to the search index on RAG Engine.

### Models

| Job | Default model | Setting |
| --- | --- | --- |
| Assistant, simple questions | `gemini-3.5-flash-lite`, thinking LOW | `GEMINI_MODEL_SIMPLE`, `GEMINI_THINKING_SIMPLE` |
| Assistant, complex questions | `gemini-4-argon`, thinking MEDIUM | `GEMINI_MODEL_COMPLEX`, `GEMINI_THINKING_COMPLEX` |
| News scan and eval judge | `gemini-3.5-flash` | `GEMINI_MODEL` |
| Search embeddings (RAG Engine) | `text-multilingual-embedding-002` | `RAG_EMBED_MODEL` |
| Memory Bank (writing memories) | `gemini-3.5-flash` | `MEMORY_MODEL` (in `platform/runtime.py`) |

These are the defaults in `models.js`. The deployed service takes its values from Terraform (`infra/terraform/ai_service.tf`), and `GET /healthz` reports the models it is running.

### Where data is kept

Everything is in asia-southeast1. On Agent Platform: the search index (RAG Engine corpora `exportmate-kb-<type>`, filled from text files in the `<project>-kb` bucket), conversations (Sessions) and what the assistant remembers (Memory Bank). In Firestore:

| Collection | Holds |
| --- | --- |
| `inventory` | The sample stock |
| `sources`, `companySources` | News feeds, and the built-in feeds each company switched off |
| `articles`, `impacts`, `scans` | Every analysed article, the alerts, and one record per scan |
| `rag_files` | Each search record's title, link, date and sources, and which RAG Engine file holds it |
| `chat_sessions` | Which Agent Platform session each browser conversation continues |
| `audits` | One record per answer: question, steps, evidence, checks, citations, raw reasoning |
| `answer_cache` | Which audits can be reused; entries expire after two days |
| `eval_runs`, `scan_eval_runs` | Results of the assistant and scan evals |

Agent Platform evaluation runs (`npm run eval:vertex`) are kept on Agent Platform › Evaluation in us-central1, in the evaluation experiment "ExportMate assistant", with their results in the project's Agent Platform staging bucket in Cloud Storage. They hold the golden cases' questions, tool results and answers, all synthetic or public data.

**Privacy.** Questions and answers are stored as asked, without masking (in the audit and the Agent Platform session), so don't paste personal data or secrets into the chat. Memory Bank is told not to keep personal details, and you can remove anything it kept. Logs carry no question text and no tokens. Your sign-in token is only ever sent to the company backend. An audit made in a company workspace can only be read with a token from that company.

## Not done yet

- Alerts are matched against the sample stock, not a company's own stock or orders.
- The assistant can't act: it doesn't draft or send supplier messages.
- You can't rate an answer or mark an alert as not relevant yet.
- Only the same question is answered from the cache; a reworded one is answered again.
- The guard on tool results is pattern-based, and Model Armor at Agent Gateway only logs what it finds until enforcement is switched on, so a reworded injection in a feed can still reach a model. Read-only tools and the auditor's link and figure checks are the other safeguards.
- The assistant remembers each person separately; facts a whole company shares aren't remembered across colleagues.
- The "five-agent review" in the demo's Rule watch is a simulation in the browser, unrelated to the assistant.

The full list, with reasons, is in [AGENT_HARNESS.md](AGENT_HARNESS.md#not-done-yet).

## For developers

```sh
cd ai/server
npm run dev        # the service on :8080 (needs gcloud auth application-default login; reads ai/server/.env if present)
npm test           # unit tests, no GCP needed
npm run runtime    # the agents behind Agent Runtime's contract; AGENTS_AT=http://127.0.0.1:8080 on the API uses them
npm run eval       # golden set against live Gemini + Firestore; saved to eval_runs (--engine: the deployed agents)
npm run eval:vertex  # the same, plus an evaluation run on Agent Platform › Evaluation
npm run eval:scan  # news scan relevance on labeled articles
npm run ops        # health of recent chats
gcloud run jobs execute exportmate-ai-task --region asia-southeast1 --wait --args="node eval/run.js"   # any of these, on GCP
```

Locally (`./dev.sh` from the repository root runs everything), the assistant and News watch read the AI service's Firestore and RAG Engine and call Gemini in its project. The backend's AI steps (document reading, requirement drafts, HS code and what-if suggestions, suggested solutions, supplier messages) need `GOOGLE_CLOUD_PROJECT` in `backend/.env`. The assistant remembers people locally only when `AGENT_RUNTIME` in `ai/server/.env` names a development Agent Runtime instance (`exportmate-agents-dev`; see `ai/server/.env.example`); without it, chat sessions are kept in memory and nothing is remembered.

When you change the AI:

- **A tool or step shape:** update `AuditStep` in `frontend/ai/chat/agent-client.ts`, and the labels and renderer in `frontend/ai/chat/Audit.tsx`.
- **The app itself:** update the help guide the assistant reads in `ai/server/seed/guides.js`, then `npm run index`.
- **A wrong answer:** add a golden case that reproduces it, fix it at the right layer, and run `npm test` and `npm run eval` before deploying. The steps are in [AGENT_HARNESS.md](AGENT_HARNESS.md#working-with-the-harness).
