# ExportMate backend — AI and agent ideas

Ideas for AI in the backend, on top of the features in [REQUIREMENTS.md](REQUIREMENTS.md) §4.5–4.7 and the AI jobs in its roadmap (§8.3). Each has a status; the rest are not decided. Some come from a past winning project ([GLOBOT_ARCHITECTURE.md](GLOBOT_ARCHITECTURE.md)). The AI service that runs today (`ai/server`) is described in [docs/AGENT_HARNESS.md](../../docs/AGENT_HARNESS.md).

Design rule for all of them: **AI reads and writes. Code decides and calculates. A person approves.**

| # | Idea | What it does | AI vs code | Example | Status |
| --- | --- | --- | --- | --- | --- |
| A | Official-text finder | From a news article, find the official rule it talks about | AI finds and quotes; operator confirms | News "EU tightens timber rules" → link to the regulation and its annex | Later (roadmap level 3) |
| B | HS code suggester | Suggest a code for orders without one | AI suggests; user confirms | "Ván ép keo 18 mm" → `4412.33` (confidence 0.8) | Deferred: needs retrieval (past orders, HS headings) |
| C | Rule-to-requirements extractor | Turn rule text into market requirements: HS include/exclude, markets, start date, required documents | AI extracts with a quote per field; reviewed before use | "Annex I: 4412, except 4412.10" → `{include:["4412"], exclude:["4412.10"]}` | Deferred: needs retrieval (PDF text, search in long texts) |
| D | Document reader | Read uploaded certificates into fixed fields (type, number, issuer, expiry, products) | AI extracts with a fixed output schema; code checks dates | FSC certificate PDF → `{type:"FSC", expiry:"2026-12-15"}` | **Built** (`POST /suppliers/{id}/documents`; a person confirms) |
| E | Missing-document check | Decide `clear` vs `exposed` from required vs uploaded documents | Code decides; AI only finds documents with different names | Required "due-diligence statement", uploaded "DDS_PO2304.pdf" → found | **Built** as code (analysis and the trade map); no AI name matching yet |
| F | Expiry watcher | Daily: flag documents that expire before an order's ship date | Code only | FSC expires 15 Dec, ship date 5 Jan → `exposed` | Partly: an expiring document is a `mismatch` in every check; no daily watcher |
| G | Amendment differ | When a rule changes, show which orders change status | AI spots "amends X"; code compares old and new requirements | Start date moved → PO-2304 `exposed` → `clear` | Later, with C |
| H | Assumption challenger | A second AI pass questions the cost and plan before the auditor | AI questions; code re-computes | "USD 200/day delay: where from? Not in company settings" → `needs_data` | Not planned |
| I | Supplier email drafter | Draft the request, following the playbook | AI drafts; person approves and sends | "Please send the DDS by 15 Dec (3 weeks, per agreement)" | Phase 3 |
| J | Reply reader | Read the supplier's reply and attachments, then re-run the check | AI reads; code re-checks | Reply with DDS attached → PO-2304 `clear` | Later |
| K | "Ready to ship" gate | Final check when the user marks an order ready | Code checks; person confirms, logged | "1 document missing, ship anyway?" | Later |
| L | Weekly digest | Summary email: new rules, status changes, expiring documents | AI writes; numbers from code | "2 orders newly exposed, 1 certificate expires in 14 days" | Partly: the company report (`/report-drafts`, kind `company`) covers it on demand; no scheduled email |
| M | Live progress stream | Show each agent step and its sources as it runs | Same step format as the `ai/server` chat | "Matching 12 orders… 2 exposed" | Not needed now: runs finish inside the request |
| N | AI test set | Fixed rules, orders and documents with expected answers, run on every prompt or model change | Code | 20 cases, must stay ≥ 95% correct | Decided (open question 22), not built for the backend |

Design points open for discussion:
- **One agent with tools vs several agents in sequence.** One is faster and cheaper; several are easier to explain in a demo. Globot used 3–5 in sequence. Decided for now: the backend runs fixed code steps; the chat is one ADK agent with tools.
- **Low confidence goes to a review queue** (e.g. under 0.8), not to `exposed` or `clear`.
- **Store every AI output with its source quote, model name and prompt version**, so a report can be re-checked later.
