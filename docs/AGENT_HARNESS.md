# Agent harness

How ExportMate's AI follows agent and harness engineering practice: what each control is, where it lives in `ai/server`, and what is not done yet. The principle: improve the system around the model rather than wait for a better model, and turn every failure into a rule, a check or a test (the "ratchet").

## The agents

| Agent | What it does | Pattern | Model | Can change data? | Human in the loop | Record |
| --- | --- | --- | --- | --- | --- | --- |
| Assistant (`agent.js`) | Answers questions about stock, news alerts, sources, the company profile and how to use ExportMate | Single agent, ReAct loop (plan → call tools → observe, at most 6 steps) plus a deterministic auditor | `GEMINI_MODEL` (default gemini-2.5-flash) | No: all six tools are read-only | Answers are informational. One that still fails the auditor after its revision is shown marked **Needs review** (`status: needs_review`) | `audits` document per answer |
| News scanner (`scan.js`) | Reads enabled feeds daily, asks which SKUs each new article affects, raises alerts | Batch pipeline with a structured-output (JSON schema) model call | `GEMINI_MODEL` | Writes alerts, articles and the vector index only | Source changes are limited to company owners and editors (checked against the backend). Alerts are advisory | `scans` document per run |

Risk tier for both: low. Neither sends messages, spends money or deletes records. When actions arrive (drafting and sending supplier messages, backend phase 3), they follow `backend/REQUIREMENTS.md` §4.7: drafted, approved by a person (who/when/hash of the exact text), then sent once with an idempotency key.

**Why one agent and not many.** `docs/agent-architecture.excalidraw` sketches a multi-agent pipeline (scouts, change detector, verifier, per-firm A1–A5). Today's tasks are small and sequential, so one tool-using agent with a separate deterministic auditor is cheaper, faster and easier to debug. Split into agents when a step becomes independent and parallel (per-jurisdiction scouts), or needs different permissions (the backend's order analysis).

Still open: name an owner for each agent and record it here.

## Layer by layer

| Layer | Control | Where |
| --- | --- | --- |
| **Policy (ratchet)** | The system prompt is built from `RULES`. Each rule says which failure it prevents (`prevents`), and `POLICY_VERSION` (a hash of the rules) is stored on every audit, scan and eval result, so behaviour changes can be traced to policy changes. The scan's rules are versioned the same way (`SCAN_POLICY_VERSION`). | `policy.js`, `scan.js` |
| **Context / RAG** | Firestore vector search (gemini-embedding-001, 768-d, cosine) with a document-type metadata pre-filter. A pool of 3× the requested results is reranked with BM25 over the candidates, so exact HS codes, SKUs and rule names (4412.33, PLY-103, EUDR) count (hybrid retrieval). Exact facts (counts, totals) come from `query_inventory`, never from search hits. | `rag.js`, `rerank.js` |
| **Freshness** | News results carry `ageDays`. The `dated-evidence` rule makes the assistant give the date and warn when news older than 30 days is used as the current rule. | `agent.js`, `policy.js` |
| **Tool harness** | The model never runs a tool directly. `toolGateway` looks the tool up in the registry, checks scope (company tools only in a signed-in company workspace, so they are neither offered nor allowed elsewhere), validates arguments against the declared schema (types, enums, required, unknown keys), enforces a per-turn budget (16 calls, 8 per tool), runs with a timeout and retries only transient failures (timeouts, network errors, 429/502/503/504, gRPC UNAVAILABLE and similar), never 400/401/403/404. Each refusal comes back to the model as a fixable error and lands in the audit with an `errorKind`. Model calls retry transient errors the same way. | `gateway.js`, `agent.js` |
| **Orchestration** | The ReAct loop is bounded at 6 steps; the last step forbids tool calls. Independent tool calls run in parallel. Recovery: transient retries, one auditor-driven revision, then `needs_review`. | `agent.js` |
| **Verification (auditor)** | Every draft is checked before it is accepted: citations resolve to retrieved evidence, every 3+ digit figure and every percentage appears as a whole number in the user's messages or this turn's tool results (earlier model turns don't count), something is cited when tools were used, every cited article or alert comes with its publication date, and links are the url of a retrieved source. A failing draft goes back once with the findings. | `review.js` |
| **Security** | Third-party text (news articles, alert text written from them, custom feed names) passes through a guard. A passage addressed to the assistant ("ignore previous instructions…") is replaced with `[removed: …]` before the model sees it and recorded as a flag on the step and the audit. The scanner withholds such articles entirely (`articlesWithheld`) and fences article text in `<article>` tags. The `untrusted-content` and `scope` rules tell the model tool results are data, and not to role-play or reveal its instructions. Least privilege: read-only tools, so an injected instruction has nothing to trigger. Feed URLs are HTTPS-only with private and metadata addresses blocked; chats are rate-limited per client and per instance; source changes need an owner or editor token. | `guard.js`, `scan.js`, `feeds.js`, `index.js` |
| **Evaluation** | Unit tests for every deterministic part (CI). A golden set of 17 cases (simple, multi-hop, tool use, follow-up, hallucination traps, edge cases, security and scope probes) with expected figures computed from the live stock. Each case is scored on the answer, the trajectory (tools and arguments), the auditor's checks and, optionally, an LLM judge (faithfulness, relevance, rubric). Each run is saved and compared with the previous one; it exits 1 on a regression. | `test/`, `eval/` |
| **AgentOps** | Every request has an ID (`X-Request-Id`, stored on the audit). One `chat.completed` JSON log line per answer for Cloud Logging (status, policy version, latency, model calls, tokens, tool errors by kind, revised, failed checks, citations, withheld passages), grouped by Cloud Trace. No question text, tokens or emails in logs. `npm run ops` summarises recent audits: pass rate, revision rate, per-check failures, p50/p95 latency, tokens and tool calls per answer, tool error rates, withheld passages, and policy and model versions in use (drift). | `log.js`, `index.js`, `metrics.js`, `ops.js` |
| **Explainability** | The audit is the explainability record: question, every plan/tool/draft/review/answer step with arguments and results, citations with dates, checks, policy version, model, tokens, latency. The app shows it under each answer and can download it as JSON. | `agent.js`, `ai/chat/Audit.tsx` |
| **Memory** | Short-term: the conversation the client sends (last 20 messages). Earlier answers keep the titles they cited but are not a data source (`tools-first` rule; the auditor ignores model turns). Long-term knowledge is the vector index. | `index.js`, `agent.js` |

## Tool registry

| Tool | Scope | Access | Data |
| --- | --- | --- | --- |
| `search_knowledge` | public | read | `kb` vector index: articles, alerts, items, sources, guides |
| `query_inventory` | public | read | `inventory` (synthetic demo stock) |
| `get_alerts` | public | read | `impacts`, `inventory`, `scans` |
| `calculate` | public | none | arithmetic only |
| `get_scan_status` | public | read | `scans`, `sources` |
| `get_company_profile` | company | read | the caller's profile from the backend (`GET /api/v1/company/knowledge` with the user's own token) |

To add a tool: add an entry to `REGISTRY` in `agent.js` with its declaration, scope and handler. Keep it read-only unless an approval step exists. Add its label in `ai/chat/Audit.tsx` and a golden case that needs it.

## Working with the harness

```sh
cd ai/server
npm test                               # unit tests, no GCP needed (also in CI)
npm run eval                           # golden set against Gemini + Firestore; saves eval/results/<time>.json
npm run eval -- --only=latest-scan     # selected cases
npm run eval -- --judge                # add the LLM judge (JUDGE_MODEL, default GEMINI_MODEL)
npm run ops                            # last 7 days of chats; --days=1, --eval, --json
```

When the assistant gets something wrong:
1. Find the answer's audit (request ID in the logs, or download it from the app) and see which step failed: retrieval, tool choice, arguments, figures or citation.
2. Add a golden case that reproduces it (`eval/golden.js`).
3. Fix it at the right layer: a tool or its schema, retrieval, an auditor check, or a rule in `policy.js` with its `prevents` line. Examples:
   - Writing the `category-count` case showed that `category: "Plywood"` also matched Hardwood plywood (production answered USD 655,181 instead of 494,053), so category and market are now enums with exact matching.
   - The first eval run on GCP (14/17, 13 Oct 2026) found the agent dropping news dates despite the `dated-evidence` rule, so the auditor now enforces them (`News cited with its date`), and writing a poem despite the `scope` rule, so that rule moved first and names what to decline. The other failure was in the judge, which marked a correct decline as irrelevant; it now grades against the rubric. Next run: 17/17.
4. Run `npm test` and `npm run eval`; no regressions before deploying.

Eval runs call Gemini and write audits with `channel: "eval"` to the same Firestore project; `npm run ops` leaves them out by default.

## Not done yet

- **Long-term memory** per company (preferences, recurring questions): not stored. The audits hold history but are not fed back.
- **Cross-encoder reranking**: retrieval uses BM25 over vector candidates, not a learned reranker; there is no relevance floor.
- **PII**: logs carry no question text, but audits store the question and answer as asked, without masking.
- **Guard coverage**: pattern-based, so a reworded injection can get past it. The read-only tools, the auditor's link and figure checks and the prompt rules are the other layers.
- **Eval in CI**: the golden set needs GCP credentials and costs model calls, so it runs by hand; only the unit tests run in CI.
- **Feedback loop**: users can't rate an answer yet, so failures reach the golden set only through audits and reports.
