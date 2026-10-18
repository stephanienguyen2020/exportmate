# ExportMate backend — requirements

What the backend must do and why: features, business rules, open questions, roadmap. How it is built: [DECISIONS.md](DECISIONS.md). Every endpoint and where the app calls it: [API.md](API.md).

The backend replaces the browser-only data (localStorage) and the simulated flows in the frontend with a real server. The browser-only demo ("Explore the demo") stays, clearly separate from live company data.

## 1. Goal

A user signs in, uploads their orders, and the backend tells them which orders are hit by a rule change, how much it costs, and what to do, with a source for every claim. Data survives refresh and works across devices.

Example end-to-end:
1. Ms. Lan (Binh Duong Wood Co.) signs in.
2. Uploads `orders.csv` with 12 orders.
3. A new version of an EU rule is added.
4. The backend finds 2 affected orders (PO-2291, PO-2304, both HS 4412.33 to the EU).
5. Report: "USD 1,200 extra cost on PO-2291: USD 400 paperwork + 4 days delay × USD 200/day", with a link to the rule clause and the CSV row.
6. Ms. Lan edits the suggested supplier email, approves it, and it is sent once.

## 2. Scope

**v1**

| Feature | Status |
| --- | --- |
| Accounts: sign up, sign in, sign out everywhere, email verification, password reset | Built |
| Company and profile: onboarding, About company (the AI assistant's company profile), account settings | Built |
| Orders: list, search, filter, detail, edit, remove | Built |
| CSV import: upload → validate → preview → commit | Built |
| Playbook rules: list, add, toggle, delete; checked rules (WHEN/THEN) | Built (checked rules: backend only) |
| Trade map: orders, suppliers and sites on a map; document checks per market; "what if" another market, ship date or route; add, edit and delete suppliers (with their documents) and sites | Built |
| Reports: an order's checklist report, or a company report (what is happening: checklist changes, news alerts, floods near suppliers, new regulation versions; what it affects: orders with gaps, suppliers). Edit anything, preview the PDF (edits marked), email it to up to five addresses (Resend, sandbox without a key); sent reports are locked | Built |
| Rule library: shared official texts and the company's own uploads, with versions | Built |
| Analysis: match rules to orders, compute cost, report with citations, block reports that fail checks | Built (backend only) |
| Rule extraction (AI drafts a company's requirements from its own regulation, the owner reviews) and HS code suggestions (from past orders and the official tariff) | Built (backend only) |
| Supplier documents uploaded as files (AI reads, a person confirms) | Built (backend only) |
| Actions: owner review of a report → AI drafts the supplier message → edit → owner approves → send once (sandbox until a Resend key); report feedback; audit log | Built (backend only) |
| Overview numbers for the dashboard | Built (except "sources checked at") |
| Contact form delivery (to the ExportMate team) | Built (backend only; the landing page form still saves to the browser) |

**Later (not v1):** Excel, PDF and photo imports (OCR); automatic crawling of official rule websites; Zalo delivery; buyer (Singapore) view with its own data; ERP connectors.

### 2.1 Assumptions

**Every official rule we match on names HS codes.**
- News articles rarely have HS codes. They are only the **trigger**. The conditions come from the **official text** (regulation, customs notice), which usually lists HS codes, often in an annex.
- If the official text has no codes (e.g. only "wooden furniture"), the AI suggests codes (`9403.x`), marked **AI-suggested**. Matching orders go to review, not `exposed`, until a person confirms.

**Products are matched by HS code, not by name.**
- "Acacia plywood 18 mm", "Ván ép keo" and "Plywood AC-18" all have HS `4412.33`, so they count as the same product.
- An order without an HS code is `exposed`, with adding the code as its next step. The AI suggests codes from the company's past orders and the official tariff lines closest to the product name; the user confirms one.

**HS codes are a tree. A rule on a parent code covers every child under it.**

```text
44          Wood and articles of wood          (chapter)
└─ 4412     Plywood, veneered panels            (heading)
   ├─ 4412.10  of bamboo
   ├─ 4412.33  other, with outer ply of certain hardwoods   ← PO-2291
   └─ 4412.39  other
      └─ 4412.39.10  (national level: EU, US and Vietnam add 2–4 more digits)
```

Matching is a prefix check plus exceptions:

```text
rule:  include HS 4412, except 4412.10
4412.33  → starts with 4412, not 4412.10 → MATCH
4412.10  → excluded                      → no match
4418.99  → different heading             → no match
```

The first 6 digits are the same in every country; digits after that differ by country. Match on 6 digits unless the rule names a longer code.

## 3. Users and companies

- A **user** works in a **company** (tenant) with a role: `owner`, `editor`, `viewer`. v1: one company per user (open question 8).
- Every action happens inside the user's company. Another company's records act as if they don't exist.
  - Example: user A in company 1 opens order PO-2291 of company 2 → not found.
- `viewer` reads. `editor` also imports, uploads and edits rules. `owner` also edits the company, approves and sends messages, and manages members.
- **Team (built):** an owner invites an email address with a role; the person signs in (or signs up) with that address and joins instead of onboarding. Invitations expire after 14 days and can be renewed or withdrawn. Owners change roles and remove members; anyone can leave. A company always keeps at least one owner, and a user is in one company at a time. Every change is in the activity log.

## 4. Features

### 4.1 Auth and account
**Status: built.**

Firebase handles sign up, sign in, email verification and password reset emails, and login rate limiting. The backend:
- Accepts only signed-in users with a verified email.
- Creates the user on their first request.
- Signs a user out on every device when they sign out.
- Onboarding saves: company name, role (manufacturer / buyer), trade route (origin country, up to 3 transit stops in order, empty = direct; destination market), currency, and a short description of what the company does. Onboarding twice is refused.
- About company (owner edits, others read): name, role, route, description, products, main materials and their origin, certifications, website, year founded, team size. It is the company's entry in the knowledge base: the AI assistant reads it with the user's own sign-in.
- Profile settings: name, alerts on/off, weekly digest on/off.

### 4.2 Orders
**Status: built.** The order page's exposures come from its latest analysis report.

- Fields: `id`, `product`, `supplier`, `destination`, value + currency, `shipDate`, `hsCode`, `status`.
- Status: `awaiting_analysis`, `clear`, `exposed` (`needs_data` is retired: missing data makes an order `exposed`; it stays only in earlier status history). New and imported orders start as `awaiting_analysis`, never `clear`; an import analyses its orders as soon as it is committed.
- List: filter by status, search by text, sorted by ship date, paged.
- Detail: the order, the CSV row it came from, and its exposures and reports.
- Edit and remove (owners and editors): every field but the order ID can be changed, with the CSV's rules; the change is audited field by field and the order is analysed again. Removing an order removes its history, reports, supplier messages, HS code suggestions and saved what-ifs; the audit log keeps what it was.

### 4.3 CSV import
**Status: built.**

Columns as in the template: `id,product,supplier,destination,value,shipDate,hsCode`, plus an optional `currency` (defaults to the company's).

1. Upload a `.csv` (max 4 MB, 10,000 rows, 60 uploads per user per hour).
2. Validate. Per-row errors:
   - `Row 4: value must be a positive number.`
   - `Row 7: order PO-2291 already exists.`
   - `Missing columns: hsCode.`
3. Preview the valid rows.
4. Commit only when the user confirms. All or nothing.

Rules:
- HS codes stay text (`0401.10` stays `0401.10`, not `401.1`). Dates are `YYYY-MM-DD`. Currencies are ISO 4217 codes.
- An `hsCode` cell may be empty (the column must be there): the order is `exposed`, its next step adding a code or accepting a suggested one (§8.4).
- Keep the original file and every row, so a report can cite "import 7, row 2".
- The same file uploaded again is flagged as a duplicate (a warning, not an error).
- Uploads never committed are deleted after 30 days.

### 4.4 Playbook rules
**Status: built.** The assistant reads the rules (text and, for checked rules, their WHEN/THEN) when it advises in chat. Analysis runs only the checked rules (backend only; `GET /playbook/fields` feeds the form, the frontend form is next), so order statuses and reports never depend on the chat.

The playbook is the company's own instructions, the way a manager briefs a new employee: "this is how we handle problems here". Each company writes its own.

- Fields: text, category (`Policy`, `Threshold`, `Supplier`, `Watchlist`), enabled.
- Every change creates a new playbook revision; old ones are kept.
- **Checked rules.** A rule can also carry a condition and an action, saved as data, so one checker runs every rule and no rule needs its own code:
  - **WHEN** one or more conditions, each *field · comparison · value*. Fields: market, supplier, HS code, order value, days until ship, missing documents, estimated cost (of the problems, without duties). Comparisons: is, is not, contains, starts with (HS code), less than, more than, includes / doesn't include (documents), is empty. Money compares only within one currency.
  - **THEN** one action: `flag` (note on the report), `owner_review` (the report goes to `needs_human_review`), `block` (no message can be sent from the report).
  - The editor picks them from dropdowns (a form). The text stays as the rule's description.
  - A rule with no condition is stored only and shown as "not checked".
  - Every report that a rule changed cites it, e.g. "sent to owner: your rule 'problems over USD 2,000'".
- Examples:

  | Rule text | WHEN | THEN |
  | --- | --- | --- |
  | "Problems over USD 2,000 go to the owner" | estimated cost > 2,000 USD | `owner_review` |
  | "Give Binh Phu Wood 3 weeks to send any new paper" | supplier = Binh Phu Wood AND missing document ≠ none AND days until ship < 21 | `flag` "can't arrive in time, move the ship date" |
  | "Never ship without the certificate of origin" | missing document = certificate of origin | `block` |
  | "Flag any order where the projected margin drops below 8%" | not possible: we don't know margin | stored only, "not checked" |

- **Rules that don't fit WHEN/THEN** stay stored and are shown as "not checked" (each report counts them):

  | Kind | Example | Later |
  | --- | --- | --- |
  | Needs data we don't have | "Flag orders below 8% profit" | Checked once we collect that data |
  | Vague | "Be careful with new suppliers" | AI flags orders it may apply to; a person decides |
  | How to write messages | "Always email suppliers in Vietnamese" | Given to the AI that drafts messages; a person approves the draft |
  | Counts across orders | "No more than 3 US orders a month from one supplier" | A new field such as "orders this month" |
  | About news, not orders | "Watch for news about Indonesian timber bans" | Used by the news scan to pick articles |

- **Later:** the editor types the sentence and AI fills in the form. The editor reviews it before saving ("I understood: WHEN … THEN …. Correct?"). The AI runs only when the rule is saved, never during analysis, so results can be repeated and cited.

### 4.5 Regulations (rule library)
**Status: built.** Drafting and review of a company's own requirements: backend only.

**Terms**
- **Regulation**: one rule, e.g. "EU Deforestation Regulation", official ID `32023R1115`. Its documents are its versions.
- **Regulation document**: one file = one version (v1, v2, …), with its title, source URL and content hash.
- **Market requirement** (the obligation): what one regulation version requires for one market, with the sentence that says so. Example: "EU · plot-level geolocation · supplier document `geolocation`", from EUDR consolidated 18.09.2026, Art. 9(1)(d).

**Two kinds of regulation**

| | Shared (official text) | The company's own |
| --- | --- | --- |
| Example | EUDR (consolidated), Lacey Act, ISPM 15, CPTPP Chapter 3 | A news article ("EU delays deforestation rules"); a buyer's own sourcing policy; an official text the library doesn't have yet |
| Added by | the seed now; the crawler (J1) and the operator later | the company's editors (upload) |
| Seen by | every company: read and download | only that company |
| New versions | seed / crawler / operator only. A company can't add one | the company's editors |
| Drives the checklists | yes: market requirements cite them | yes, once the owner reviews the requirements AI drafted from it; only for that company |

**Use cases**
1. *Built.* Ms. Lan opens the trade map. PO-2291 to Rotterdam shows "Plot-level geolocation: missing". The check names its source, EUDR Art. 9(1)(d), and she downloads the official text.
2. *Built.* She uploads a news article about an EUDR delay. It becomes her company's regulation, v1. Other companies don't see it; the checklists don't change.
3. *Built (backend).* Her buyer sends a sourcing policy ("FSC for all solid wood") as a PDF. She uploads it as a company regulation and asks for drafts. AI drafts "EU · FSC chain of custody · supplier document `chain`" with the quote, which code finds in the PDF's text. She (the owner) approves it. From then on her orders to the EU are checked for it; other companies never see it. A scanned PDF has no text: AI reads the image and the quote is marked unchecked until she confirms it.
4. *Later.* EUR-Lex publishes a new consolidated EUDR. The crawler stores it as v2 of the shared regulation; the extraction agent drafts its market requirements; a reviewer approves them; they replace v1's. The map now shows a newly missing document on PO-2304.

**Uploading** (company regulations)
- **New version = the uploader says so.** On upload they pick "new regulation" or "new version of [regulation ▾]". The form can pre-select the regulation when the typed official ID matches one. Detecting versions without the uploader is a goal (§8.1).
- The same file twice in one regulation is refused; another regulation or another company may upload the same file. An official ID names at most one regulation per company.
- Files: `.pdf`, `.html`, `.txt`, up to 4 MB, 60 uploads per user per hour. Downloads are always attachments, so uploaded HTML is never shown as a page on our domain.
- Not the same as supplier documents (§4.9): a regulation document says what is required; a supplier document is the proof a supplier holds.
- The source URL is kept as a reference; the backend doesn't fetch it.

**Market requirements (obligations)**
- Each cites one regulation document (a version) and a quote from it. A requirement with no verified official text is not shown.
- A requirement can state a duty as a share of the order value (`dutyRatePercent`, e.g. Section 232: 25%). Analysis prices it from that figure.
- Level: `supplier` (checked against the supplier's documents of the same kind), `shipment` (paperwork prepared per shipment), `check` (a reminder, e.g. a tariff).
- Who writes them:

  | Field | Now | Later |
  | --- | --- | --- |
  | Source (which version) | The seed downloads the official text | The crawler stores the new version (J1) |
  | The requirement and its quote | Shared: written by hand in the seed, copied from the downloaded text and checked. Company: drafted by AI from the version's text (PDF, HTML, plain text; long texts cut down to the closest sections), each quote checked against the text; the owner reviews (`draft` → `reviewed` / `rejected`) | Shared: drafted by the extraction agent (J3) from crawled versions; the operator reviews |

- Only reviewed requirements are checked and raise alerts (seed requirements count as reviewed). A new version gets its own requirements; once none is left as a draft (and at least one is reviewed), they replace the previous version's. Until then the previous version's stay in use. Comparing the two lists shows what was added, changed or removed. A report records the version it checked against.

**Choosing official texts** (the seed now, the crawler later)
- Official publisher, latest consolidated text (EUDR consolidated 18.09.2026 includes its 3 amendments). With no consolidated text, the base act is v1 and each amending act the next version (Section 232: Proclamation 10976, then the January 2026 amendment).
- The backend must be able to download it from the cloud. Some official sites block cloud servers (legislation.gov.uk, japaneselawtranslation.go.jp, forest.go.kr). Then use another official host and say so in the title: the EU Publications Office for EUR-Lex texts, a country's WTO notification, a ministry's official outline.
- Law only. Market practice is not a requirement (the UK "buyers expect a formaldehyde test" line was dropped). Paid standards (JIS, EN) are not stored; cite the law that requires them (EU formaldehyde: REACH entry 77).
- Each text is downloaded once. A failed download leaves that text and its requirements out until the next deploy. Texts may be large (EVFTA, a whole treaty, is 22 MB).

### 4.6 Analysis (runs and reports)
**Status: built (backend only).** `POST /runs` runs every step in code and finishes inside the request; nothing waits on AI. Cloud Tasks come in when a step does (the phase 3 message draft).

A **run** checks orders against the market requirements:
1. **Relevance**: which market each order's destination is in. Orders outside every market need action: their next step is the missing checklist.
2. **Exposure**: the same check as the trade map (§4.9): the destination gives the market, the HS code picks the market requirements that apply, and the supplier's documents are checked against them. A `missing` or `mismatch` result makes the order exposed. No supplier record → `needs_data`, not `clear` (question 3).
3. **Cost**: computed in code, not by the AI (question 5). Each cost line names where its number came from:
   - **the rule's own figure** when it has one: Section 232 25% × USD 54,300 = USD 13,575, cited to Proclamation 10976. If the stated rate changes on or before the ship date (Section 232 rises on 1 January 2027), the duty is named with no amount: "rate changes on 1 Jan 2027, recheck";
   - otherwise a **company setting**, starting from a shared default the company can change: delay USD 200/day by default (Lan sets USD 350/day); getting a missing document USD 400; a new lab test USD 400; a supplier needs 14 days to send a document. A missing document 10 days before shipping = USD 400 + (14 − 10) days × USD 200 = USD 1,200;
4. **Playbook**: run the company's checked rules (§4.4) against the order and its cost, and record which rules fired.
5. **Plan**: suggest one action, in code: complete the data, ask the supplier by a date, move the ship date (the supplier can't make it), recheck the landed cost, or nothing. Drafting the message is phase 3.
6. **Auditor**: every finding has a quote, every cost line re-computes and names where its number came from, totals add up. Fail → `needs_human_review` (the steps are code, so a retry would give the same answer).

- Report states: `pass`, `rejected`, `needs_human_review` (`needs_data` only on reports made before it was retired). Only `pass` reports with nothing in `missingData` that no `block` rule stopped can lead to a message.
- Each order's status follows its latest report: `exposed` (a document missing or mismatched, or data missing: HS code, market checklist, supplier record) or `clear`. A duty alone doesn't make an order exposed.
- A report keeps a copy of everything it cites (findings with quotes, settings used, rules fired), so it reads the same after requirements, rules or settings change. It also cites the CSV row the order came from.
- **One report, two views.** The analysis report is the source of truth. The order report a person edits and emails (`/report-drafts`) repeats the latest analysis (next step, costs, rules fired) next to the live checklist, and says when it is missing or out of date. The chat assistant reads orders and rules through the backend; later it reads analysis reports too.
- Each run saves a short summary per step, so the UI can show what happened. Users never see raw AI reasoning.

### 4.7 Actions (messages)
**Status: built (backend only).**

**Use case.** PO-2291 is missing the plot geolocation from Binh Phu Wood. Lan opens the order's report and clicks "Draft email to supplier". AI writes, in English, a short request naming the order, the product, the document and the regulation behind it, and the date to ask by. The "To" field holds the supplier's contact email (Minh); Lan confirms it or types another, and can save it to the supplier. The owner approves the exact text and sends it. Replies come back to the owner's own inbox.

- **Which reports can lead to a message:** the order's latest report, not blocked by a playbook rule, past its checks, with something missing. When a playbook rule sent it to the owner (`needs_human_review`), the owner first clicks "Reviewed: OK to contact the supplier" (with an optional note). A report that failed its checks can't be reviewed away: run the analysis again.
- State flow: `draft → approved → sent`, or `failed` (the email service refused it; it can be sent again). Delivery confirmation (`delivered`) needs a Resend webhook: later.
- Editing the recipient, subject or body after approval resets it to `draft`.
- Approval records who, when, and a hash of the exact recipient, subject and body. The owner may approve their own draft (one-person companies); it is recorded.
- Sending is idempotent: the row is locked and a double click sends one email.
- Sending does **not** clear the exposure. New evidence and a new passing analysis do.
- v1 channel: email through Resend; a sandbox (nothing delivered) until a key and a verified sender domain are set.
- AI writes only from the report's facts: no prices, costs or internal notes, links only to the sources the report cites. The company's playbook rules about writing to suppliers are passed to it.
- **Feedback:** anyone can mark a report useful or not, with a note; later these become cases for the AI test set (question 22).
- **Audit log:** the owner sees who imported, edited, reviewed, approved and sent what, and when.

### 4.8 Overview
**Status: built, except "sources checked at"**, which needs the crawler (phase 4). Until then the dashboard reads the news scan time from the AI service.

Order counts by status, value at risk per currency (exposed orders), nearest affected ship date, last time sources were checked.
Example: 2 exposed, 10 clear, USD 2,400 at risk, nearest affected ship date 27 Oct 2026.

### 4.9 Trade map
**Status: built.**

A map of the company's own export activity: its suppliers, sites and markets, and the orders between them.
- Each order is placed from its destination text (`Rotterdam, NL` → NL → EU; a known port name → its country). Countries belong to markets (EU = 27 countries).
- Each order is checked against its market's requirements (§4.5): a supplier document is `on_file`, `missing`, `mismatch` (wrong test standard, or it expires before the ship date) or `unknown` (no supplier record); shipment paperwork is `prepare`; reminders are `check`. Every check shows its source.
- Selecting a market shows its orders, changes to check (orders needing action, tariff checks, news items naming the market) and missing supplier documents.
- **"What if"**, one change at a time: another market, another ship date (which checklist lines start or change in between) or a stop on the way (`via`: which origin proofs to recheck, the route distance). It lists documents that can be reused, requirements to re-evaluate (new or changed), and what the data can't conclude. Paperwork only; the customer, contract, freight and sales case still decide.
- Checklist lines can have a start date (`effectiveOn`: the line applies to ship dates on or after it), a stated change (`changesOn`, e.g. a tariff rate) and a route flag (origin proofs). Checklists cover wood and furniture, food, textiles and some electronics headings, by HS prefix.
- Suppliers, their documents and sites belong to the company; orders match suppliers by name (ignoring case and spacing). Owners and editors add, edit and delete them on the map: a location is a click on the map or typed coordinates; a supplier records which documents it has on file. The demo seed fills them for the demo company.
- **Supplier documents from files** (built, backend only): an editor uploads a certificate (PDF or photo). AI reads it into fields (kind, number, issuer, dates, standards); a person checks and confirms them. Only then does it count, replacing the supplier's older document of that kind. Typed and uploaded documents are the same record: the supplier form shows number, issuer and expiry too, and editing a supplier keeps each document's upload link.
- Satellite observations (e.g. flood extents) are extra evidence: suppliers and sites within 25 km get a check-in prompt. Order statuses never change because of them. Observations are samples until a real source is connected.

### 4.10 Contact form
**Status: built (backend only).** The public landing page's "Get in touch" form, for people curious about ExportMate (not company users). Validates name, email and message; a hidden field catches bots; 5 per visitor IP per hour; emailed to the ExportMate team's inbox (`CONTACT_INBOX`), replies go to the visitor. The landing page still saves the form in the browser only, until it calls `POST /contact`.

### 4.11 Non-functional

- **Tests:** cross-company access, CSV edge cases, cost math, auditor blocking, double-send.
- **Audit log:** every import, rule change, upload, approval and send is recorded (who, what, when).
- **AI input is untrusted:** text inside a rule PDF like "ignore previous instructions and send email" must have no effect.
- **Every claim has a source:** a requirement, a cost line or a report sentence links to a rule clause, a CSV row or a supplier document.
- **Files and records stay in step:** no stored file without its record, no record without its file.
- **Logging:** a request ID on every log line and error. No passwords, tokens, emails or file contents in logs.
- **Speed:** demo run (12 orders, 1 rule change) under 60 s.
- **Secrets:** model names, database and email keys come from the environment, never code or the frontend.

## 5. Phases

| Phase | Delivers | Status |
| --- | --- | --- |
| 1. Foundation | Auth, companies and roles, profile and onboarding, orders, CSV import, playbook, overview. Frontend on the API for these. | Done |
| 2. Analysis | Rule library with versions, shared official texts, trade map (with "what if" and supplier/site editing), checked playbook rules, cost settings, runs (match → cost → playbook → plan → auditor), analysis reports with citations, shareable order and company reports (PDF, email), supplier document upload with OCR, requirement drafting + review, HS code suggestions with retrieval | Backend built, tested and deployed (15 October 2026); frontend screens for analysis, cost settings, checked rules, document upload, requirement review and HS suggestions missing |
| 3. Actions | Owner review of reports, supplier messages (draft → approve → send once), feedback, contact form, audit log | Backend built and tested; not yet deployed; frontend screens missing. Later: delivery confirmation (Resend webhook) |
| 4. Connect + automate | Chat reads orders and the playbook through the backend (built: `query_orders`, `get_playbook`), chat reads analysis reports, analysis runs on events (open question 20), scheduled source watching (crawler) and "sources checked at", following shared regulations, buyer tenant, Excel import | Later, except chat reading orders and the playbook |

Each phase ends with: tests green, deployed, frontend working against it.

## 6. Open questions

| # | Question | Options / note |
| --- | --- | --- |
| 1 | Inventory vs orders | `ai/server` uses 31 synthetic SKUs; the frontend uses 12 orders. Same data or separate? |
| 2 | ~~Which real rule do we demo?~~ | **Decided:** the trade map cites real official texts (EUDR consolidated 18.09.2026, Lacey Act, …). The rule-change demo uses US Section 232: Proclamation 10976 (6 Oct 2025) → amendment 91 FR 1039 (9 Jan 2026), both already in the seed. |
| 3 | ~~Do we need BOM / materials / supplier lots in v1?~~ | **Decided: no.** Match like the trade map: HS code + destination → market requirements, checked against the supplier's documents (§4.6 step 2), so the map and the reports always agree. Materials per order or supplier lots only if buyers need them. |
| 4 | ~~Do playbook rules affect analysis in v1?~~ | **Decided:** yes, through checked rules: WHEN/THEN saved as data and picked from a form; one checker runs all of them (§4.4). Rules that need data we don't have (margin) stay "not checked". Later: AI fills in the form from the sentence and the editor reviews it. |
| 5 | ~~Where do cost assumptions come from?~~ | **Decided:** the rule's own figure when it gives one (tariff %, duty rate); otherwise shared defaults that each company can change in its settings. Each cost line names its source. Not entered per order (§4.6 step 3). |
| 6 | ~~Agent framework~~ | **Decided:** the chat assistant (`ai/server/agent.js`) is a Google ADK `LlmAgent` (JS); the harness (gateway, guard, auditor, audits) plugs into ADK's tools and callbacks. The backend's AI steps are plain Gemini calls (`core/gemini.py`): code runs the steps in a fixed order and the AI only reads or writes text inside one. |
| 7 | ~~Email provider for messages and the contact form~~ | **Decided:** Resend (`core/email.py`), first used for emailed order reports; sandbox without `RESEND_API_KEY`. (Auth emails are Firebase's.) |
| 8 | Several companies per user? | v1 is one company per user. Needed for consultants or a buyer working with several suppliers? |
| 9 | Buyer (Singapore) tenant | In v1 or later? The UI's maker/buyer switch is a fake today. |
| 10 | ~~Who reviews extracted requirements?~~ | **Decided for phase 2:** the company owner reviews requirements drafted from the company's own uploads. Shared requirements stay hand-written in the seed and are reviewed as code until the operator role exists (24). |
| 11 | ~~Keep a demo mode?~~ | **Decided:** "Explore the demo" is a browser-only session with sample data, separate from live company data. |
| 12 | ~~From a news article to the official text~~ | **Decided:** v1 manual upload; later official APIs; stretch: agent search + human confirm (§8). |
| 13 | ~~How much of the code do we match on?~~ | **Decided:** 6 digits, prefix check in code, no AI (§8). |
| 14 | ~~Rule amendments~~ | **Decided:** store the consolidated text as the next version; with none, each amending act is a version (§4.5). Stretch: the agent drafts merged conditions, a person reviews. |
| 15 | ~~Who confirms AI-suggested HS codes?~~ | **Decided:** the company's editor; the CSV value is never overwritten (§8.4). |
| 16 | Conditions that aren't HS codes | **Partly built:** a line can start on a date (`effectiveOn`, compared with the ship date) and be route-sensitive (origin proofs). Matching is otherwise HS code + destination (3). Later: origin country, company size, order value thresholds, wood species; some need data we don't have. |
| 17 | ~~Markets vs countries~~ | **Decided:** a market groups countries; the destination text is parsed (§4.9). |
| 18 | ~~Which documents does a rule require?~~ | **Decided:** a market requirement is the obligation; it names a document kind and cites its regulation version (§4.5). |
| 19 | ~~Vector store~~ | **Decided:** `pgvector` in the backend's Postgres for the official HS headings (embedded once at seed time). Past orders use word similarity (`pg_trgm`); sections of a long regulation are embedded in memory while drafting, never stored. Supplier documents aren't searched yet. `ai/server` keeps Firestore vector search for its own index. |
| 20 | When do checks re-run? | **Decided for phase 2:** when an editor clicks "Analyse" (`POST /runs`) and when a CSV import is committed (its new orders). **Direction:** analysis runs on events (CSV import, a supplier document confirmed, a rule or regulation change, a daily expiry check), the shareable order report and the chat read its latest report. |
| 21 | ~~Language~~ | **Decided for now:** English everywhere: the UI, reports, supplier messages and the AI's answers. Vietnamese later, as one change across the whole app (not per feature). |
| 22 | ~~How do we test AI quality?~~ | **Decided:** a developer test set, not a user feature. About 20 cases with known answers per AI job (supplier document reading now; extraction and HS code suggestion when built), e.g. "Oak dining table" → HS 9403.60. Not built yet for the backend. Run by hand before changing a prompt or the model; a case that passed and now fails blocks the change. Same approach as `ai/server/eval/`. |
| 23 | Where does crawling live? | **Leaning `ai/server`**: it already has per-company news sources (shared built-ins a company can switch off, plus its own feeds). Still open: does a backend `watch_sources` table replace this, or does the backend read sources from `ai/server`? |
| 24 | Operator role | Platform staff (us) who maintain the shared library and review extracted requirements. A flag on users, or a separate admin app? **Not in phase 2:** the seed is reviewed as code (10). |
| 25 | A company's own requirements | **Built:** market requirements can belong to one company (drafted by AI from its own regulation, reviewed by the owner) and are checked next to the shared ones (§4.5 use case 3). Later: companies **follow** shared regulations, request missing ones, and matching checks only followed ones. |

## 7. Roles

| Who | Does |
| --- | --- |
| **Operator** (our staff, later) | Maintains the shared rule library: adds official texts, reviews extracted requirements. |
| Company **owner** | Everything an editor does, plus edits the company and its cost settings, approves outgoing messages (phase 3), reviews requirements drafted from the company's own regulations, invites people and manages roles. |
| Company **editor** | Imports orders, edits the playbook, suppliers and sites, uploads the company's own regulations and supplier documents (and confirms what AI read), runs analysis, emails reports. Later: confirms AI-suggested HS codes, manages watch sources. |
| Company **viewer** | Reads, and prepares reports (only the author sees a draft). |

## 8. Rule sources and matching: roadmap

Everything not marked **built** is a goal. We can pitch the whole path, labelled by level, while we build it.

### 8.1 Levels

| Level | Sources | Rule text | Matching | Status |
| --- | --- | --- | --- | --- |
| 0 | News feeds in `ai/server` (Timber Trades Journal, VnExpress, EU press releases, Google News searches). Shared built-in feeds, which a company can switch off for itself, plus feeds a company adds for itself. | — | `ai/server` maps articles to its 31 SKUs (AI) | **Built** (`ai/server`) |
| 1 | + Shared official texts (seed) and the company's own uploads (official text or article) | Consolidated text as the next version; shared requirements written by hand in the seed; the company's own drafted by AI and reviewed | Trade map and analysis document checks (code); AI suggests HS codes for orders without one. Next: 6-digit HS prefix + exceptions | **Built**, except HS exceptions |
| 2 | + Crawler (J1): per-company watch list + official APIs (US Federal Register, EUR-Lex) | Extraction agent drafts requirements, a person reviews | Same | Phase 4 |
| 3 (stretch) | + Agent goes from a news article to the official text (Gemini grounding with Google Search, EUR-Lex search); a person confirms | Agent spots amendments and drafts merged conditions; a person reviews. Version detection without the uploader picking (below) | + AI flags CSV codes that don't fit the product; 8–10 digit national codes when a rule names them | Goal |
| 4 (stretch) | + Vietnamese official sources, more markets | Same | Same | Goal. Started: checklists already cover food, textiles and some electronics headings |

Pitch line: "The agent finds the likely official text and shows it to you. You confirm it before it's used."

**Knowing a file is a new version of a regulation.** Built: the uploader picks it. Goals, in order:

| Way | How | Level |
| --- | --- | --- |
| Same URL, new content | The crawler fetches a known URL again and the hash changed → next version of the same regulation | 2 |
| Official ID | Read the ID from the file (EUR-Lex CELEX: `32023R1115` original, `02023R1115-20260918` consolidated; US: `7 CFR 357`). Same base ID → same regulation; the date orders versions | 2 (suggest), 3 (automatic) |
| AI match | AI compares title and summary with existing regulations: "looks like a new version of X"; a person confirms | 3 |

A wrong automatic link would compare unrelated texts and raise wrong alerts, so every automatic way starts as a suggestion.

### 8.2 Data (high level)

| Record | Holds |
| --- | --- |
| Regulation | **Built.** Title, optional official ID (unique per company, and among shared ones), owning company or none (shared) |
| Regulation document | **Built.** One version: number, title, source URL, file, content hash (a file can be in a regulation only once). The company comes from the regulation. Later: kind (official text / article), fetched date for crawled files |
| Market requirement | **Built.** One requirement in a market's checklist: level, document kind, accepted standards, HS prefixes, duty rate, start date (`effective_on`), a stated change (`changes_on`, `change_note`), route-sensitive, the regulation version it comes from, its quote and whether the quote was found in the text, the company for a company's own, `draft` → `reviewed` / `rejected` → `replaced`. Later: HS exclude |
| Watch source | Later. Company (or shared), URL, kind (`rss`, `federal_register`, `eurlex`, `page`), enabled, last checked |
| Followed regulation | Later. Which company follows which shared regulation |
| HS code suggestion | **Built.** Order, suggested code, its official description, reason, what it was based on (past orders, tariff lines), `pending` / `accepted` / `rejected`, who decided. Later: confidence |
| HS heading | **Built.** The official 4- and 6-digit tariff lines of every HS chapter, so suggestions work whatever a company makes (USITC HTS, `seed_data/hs_headings.json`, built by `scripts/build_hs_headings.py`), with an embedding of each description. Only the official source changes it: re-build for a new HS edition (HS 2027 takes effect on 1 January 2027; orders shipping after it will need their codes mapped). A company's confirmed codes teach its own examples (past orders), never this list |
| Analysis run and report | **Built.** Run: status, step summaries, playbook revision and cost settings used. Report per order: state, order status, blocked, and its content as JSON |
| Cost default / company cost setting | **Built.** Key, label, unit (`days` or a currency), value |
| Supplier document upload | **Built.** File in Cloud Storage, what AI read, `draft` → `confirmed`. A supplier document (typed or confirmed) has number, issuer, expiry and the upload it came from |
| Report draft | **Built.** An order or company report: the generated `original`, the edited `content`, who sent it to whom and when (locked once sent) |

### 8.3 AI jobs (high level)

Jobs that wait on AI run as background tasks (DECISIONS.md §4); J4 is code and runs inside the request. Each saves its steps and stores every AI output with its source quote, model and prompt version.

**J1 Crawl** (daily)
For each enabled watch source: fetch new items → skip ones already seen (by hash) → official texts become the next version of a shared regulation, articles go to J2. Same download rules as the seed (§4.5). New official versions go to J3.

**J2 Analyse article**
1. AI: is this a rule change, a disruption or noise?
2. AI: which markets and products does it mention? Compare with the company's markets and order HS codes.
3. (Level 3) AI: search for the official text (Google Search grounding, EUR-Lex). Show the top candidates with links.
4. Output: an alert, "EU timber rule update may affect 2 of your orders; suggested official text: [link], confirm?"

**J3 Extract from official text** (built for a company's own versions: `POST /regulation-documents/{id}/requirements`; the owner reviews. Shared versions wait for the crawler)
1. Read the text (PDF text extracted, so quotes can be checked; a scanned PDF goes to AI as a file and its quotes are marked unchecked). Long texts: keep the sections closest in meaning to an exporter's obligations, and send only those.
2. AI (fixed output schema): market requirements for the new version (market, level, document kind, HS codes, start date), with the exact clause quoted for each.
3. Saved as `draft`. The operator (or the owner, for a company's own version) reviews and edits → `reviewed`; they then replace the previous version's requirements.
4. Compare with the previous version's requirements → list what changed → queue J4.

**J4 Match orders** (code only, no AI; built as analysis runs, §4.6)
For each reviewed requirement × each company order: 6-digit prefix + exceptions + market + date → `clear` / `exposed`. Only orders whose status changed raise an alert.

**J5 Suggest HS code** (when an order has no code; built)
1. Retrieve: the company's past orders with similar product names that have a code (word similarity), and the official tariff lines closest in meaning (embeddings).
2. AI: top 3 codes from those, each with a description, a reason and what it was based on.
3. Code keeps real tariff lines and the citations AI was shown. Saved as `pending`. The order stays `exposed` until a code is accepted.
4. The editor accepts one → the order gets the code → J4 runs for that order.

### 8.4 HS code cases

| Case | What happens |
| --- | --- |
| CSV has a code | Use it. No AI. |
| CSV code is empty | J5 suggests; the editor confirms; then matching runs. |
| CSV code looks wrong for the product (e.g. "Milk powder" + 4412.33) | Level 3: AI flags "code doesn't look like the product". The CSV value stays; the editor decides. |
| Excel/PDF import (later) | Same as an empty code. |

Matching itself is always code (prefix check), never AI, so the same input always gives the same answer.
