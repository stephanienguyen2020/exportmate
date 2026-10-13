# ExportMate backend — API

What each endpoint does and where the app uses it. Business rules are in [REQUIREMENTS.md](REQUIREMENTS.md); technical decisions in [DECISIONS.md](DECISIONS.md). The live contract (exact field types) is the OpenAPI page at `/api/v1/docs`.

## Basics

- Prefix: `/api/v1`. The frontend calls it via `frontend/src/api.ts` (`VITE_BACKEND_API_URL`, default `/api/v1`; Vercel and Vite route it to this service).
- Auth: `Authorization: Bearer <Firebase ID token>` on every route except `/health`. Locally with `AUTH_MODE=dev`: `Bearer dev:lan@example.com` (`dev-unverified:<email>` simulates an unverified email).
- JSON is camelCase. Money is `valueMinor` (hundredths of the unit, for every currency: `2400000` = 24,000.00) + `currency`.
- Success: `{"data": ..., "meta": {...}}`. Error:
  ```json
  {"error": {"code": "invalid_input", "message": "Some fields are invalid.", "fieldErrors": {"name": "..."}, "requestId": "3f9c..."}}
  ```
- Every response has an `X-Request-ID` header (sent by the client or generated). Search logs with it.

**Roles**: `viewer` reads. `editor` also uploads and edits. `owner` also edits the company.

**Errors any company route can return**

| Status | `code` | When |
| --- | --- | --- |
| 401 | `unauthenticated` | No token, or the token is bad or expired |
| 401 | `session_revoked` / `account_disabled` | Signed out everywhere / account disabled in Firebase |
| 403 | `email_not_verified` | The token's email is not verified |
| 403 | `onboarding_required` | The user has no company yet. The frontend sends them to `#/onboarding` |
| 403 | `forbidden` | The caller's role is too low |
| 404 | `not_found` | Missing, or it belongs to another company |
| 422 | `invalid_input` | Validation failed. `fieldErrors` holds one message per field |
| 429 | `rate_limited` | Upload limit reached (60 per user per hour, counted per instance) |

## Index

| Endpoint | Role | Used by |
| --- | --- | --- |
| `GET /health` | none | Uptime checks, `deploy.sh` |
| `GET /me` | signed in | Sign-in, every workspace load, Account settings; `ai/server` |
| `PATCH /me` | signed in | Account settings |
| `POST /me/logout` | signed in | `#/logout` |
| `POST /onboarding` | signed in, no company | Onboarding wizard |
| `PATCH /company` | owner | Account settings (About company) |
| `GET /company/knowledge` | viewer | `ai/server` chat only |
| `GET /overview` | viewer | Dashboard |
| `GET /orders` | viewer | Every workspace load |
| `GET /orders/{id}` | viewer | Order detail page |
| `POST /imports` | editor | Upload screen |
| `GET /imports/{id}` | viewer | Upload screen (preview) |
| `POST /imports/{id}/commit` | editor | Upload screen ("Import") |
| `GET /playbook/rules` | viewer | Every workspace load |
| `POST /playbook/rules` | editor | Playbook: add rule |
| `PATCH /playbook/rules/{id}` | editor | Playbook: on/off toggle |
| `DELETE /playbook/rules/{id}` | editor | Playbook: delete |
| `GET /trade-map` | viewer | Trade map |
| `GET /trade-map/compare` | viewer | Trade map: "What if" panel |
| `POST /regulation-documents` | editor | Regulation library: add regulation / version |
| `GET /regulation-documents/{id}` | viewer | Regulation library |
| `GET /regulation-documents/{id}/file` | viewer | Regulation library |
| `GET /regulations` | viewer | Regulation library |
| `GET /regulations/{id}` | viewer | Regulation library |
| [Planned](#planned) | | Phases 2–4 |

"Every workspace load" means `refreshWorkspace()` in `frontend/src/main.tsx`. It runs on entering the workspace, after a commit, and on "Retry". It calls `GET /me`, then `GET /orders`, `GET /playbook/rules` and `GET /overview` in parallel. The browser-only demo session calls none of these: it uses localStorage.

---

## Health

### `GET /health`
Returns `{"data": {"status": "ok"}}`. No auth, no DB call. Logged at debug level only.

## Account

### `GET /me`
Who is calling and their company. On the first call it creates the user row from the token.

```json
{"data": {
  "user": {"id": "…", "email": "lan@example.com", "name": "Lan", "alerts": true, "digest": false},
  "company": {"id": "…", "name": "Binh Duong Wood Co.", "businessRole": "Manufacturer",
              "origin": "Vietnam", "transit": ["Singapore"], "destination": "European Union",
              "currency": "USD", "description": "…", "products": "…", "materials": "…",
              "certifications": "…", "website": "https://…", "foundedYear": 2009,
              "teamSize": "51-200", "updatedAt": "…"},
  "role": "owner",
  "onboarded": true}}
```
`company` and `role` are `null` until onboarding.

- **Sign-in** (`enterWorkspace`, `frontend/src/Account.tsx`): `onboarded` decides whether to go to `#/onboarding` or the page the user came from.
- **Workspace load**: the result is cached in `em-profile` (`cacheAccount`), which fills Account settings and the header.
- **`ai/server`**: calls it with the user's token to read the company ID and role before changing news sources or starting a scan (owner/editor only). It caches the result for 1 minute per token.

### `PATCH /me`
Body: any of `name` (1–200 chars), `alerts`, `digest`. Returns the same shape as `GET /me`.
Account settings → Save calls it first, then `PATCH /company` if the owner changed company fields, then `GET /me`.

### `POST /me/logout`
Revokes the user's Firebase refresh tokens, which signs them out on every device. Returns `{"signedOut": true}`. Other instances honour it within 60 s (their revocation check is cached). In dev mode it does nothing.
Called from `#/logout` in a live session, before the Firebase sign-out. If it fails, the page shows "Signed out locally. Could not revoke other sessions: …".

### `POST /onboarding`
Creates the company and makes the caller its `owner`. Returns `201` with the `GET /me` shape.

```json
{"companyName": "Binh Duong Wood Co.", "businessRole": "Manufacturer",
 "origin": "Vietnam", "transit": ["Singapore"], "destination": "European Union",
 "currency": "USD", "description": "Plywood and outdoor furniture for EU retailers."}
```
- `businessRole`: `Manufacturer` | `Buyer / trader`. `transit`: 0–3 stops in order (`[]` = direct). `currency`: an ISO code, default `USD`. The frontend always sends `USD`. `description` is required and must not be blank.
- `409 already_onboarded` if the user already has a company. Double submits are safe: the user row is locked.

Last step of the onboarding wizard (`frontend/src/Account.tsx`).

### `PATCH /company` (owner)
Changes only the fields sent. Optional fields (`website`, `foundedYear`, `teamSize`, and `products`/`materials`/`certifications` with `""`) are cleared with `null`. Required fields (`name`, `businessRole`, `origin`, `transit`, `destination`, `description`) can't be set to `null`. `transit` replaces all stops.
- `website` without a scheme gets `https://`. `foundedYear` is 1800 to this year. `teamSize` is `1-10` | `11-50` | `51-200` | `201-500` | `500+`.
- Returns the company. Editors and viewers get `403 forbidden` and see these fields read-only.

Account settings → About company. The frontend sends every field, with empty optional ones as `null`.

### `GET /company/knowledge` (viewer)
`{"company": {…same as GET /me…}, "sites": [{"name": "Cat Lai bonded warehouse", "kind": "warehouse", "place": "…"}]}`

Not called by the frontend. When a signed-in user chats, `ai/server` calls it with the user's token (`BACKEND_URL`) and gives the profile to the agent's `get_company_profile` tool. If it fails, the chat falls back to the anonymous demo.

## Orders

### `GET /overview` (viewer)
```json
{"data": {"totalOrders": 12,
  "countsByStatus": {"awaiting_analysis": 9, "clear": 1, "exposed": 2, "needs_data": 0},
  "valueAtRiskByCurrency": {"USD": 4810000},
  "nearestAffectedShipDate": "2026-10-27",
  "sourcesCheckedAt": null}}
```
- `countsByStatus` always lists all 4 statuses. Value at risk and nearest date count only `exposed` orders, and the date only counts ship dates from today on.
- `sourcesCheckedAt` is always `null` for now. The dashboard takes its scan time from `ai/server` `/api/impacts`.

Dashboard tiles, loaded on every workspace load.

### `GET /orders` (viewer)
Query: `status` (`awaiting_analysis` | `clear` | `exposed` | `needs_data`), `q` (≤100 chars, case-insensitive substring of id, product, supplier, destination or HS code), `limit` (1–200, default 50), `cursor`.
Sorted by `shipDate`, then `id`. `meta`: `{"total": 12, "nextCursor": "…" | null}`. A bad cursor gives `422 invalid_cursor`.

```json
{"id": "PO-2291", "product": "Acacia plywood · 18 mm", "supplier": "Binh Phu Wood",
 "destination": "Rotterdam, NL", "valueMinor": 2400000, "currency": "USD",
 "shipDate": "2026-10-27", "hsCode": "4412.33", "status": "exposed"}
```
On every workspace load, `api.orders()` reads every page (`limit=200`) until `nextCursor` is null. Search and status filters on the Orders page then run in the browser; the frontend doesn't send `status` or `q` yet.

### `GET /orders/{id}` (viewer)
`{id}` is the company's own order ID (`PO-2291`).
```json
{"data": {"order": {…as above…},
  "source": {"importId": "…", "rowNumber": 2, "rowHash": "…",
             "raw": {"id": "PO-2291", "product": "…", "value": "24000", "…": "…"}},
  "exposures": []}}
```
`source` is the CSV row the order came from, or `null` for seeded orders. `exposures` stays empty until analysis exists (phase 2).
Opening `#/workspace/orders/<id>` in a live session.

## CSV import

Upload screen, live session: choose file → `POST /imports` → `GET /imports/{id}` → show errors and preview → "Import" → `POST /imports/{id}/commit` → toast "N orders imported. Awaiting analysis." → workspace reload. The demo session parses the file in the browser instead (PapaParse, `frontend/src/order-csv.ts`, with the same checks).

### `POST /imports` (editor, rate limited)
`multipart/form-data` with `file`. `.csv` only, ≤4 MB, ≤10,000 rows. Columns: `id,product,supplier,destination,value,shipDate,hsCode` (+ optional `currency`, which defaults to the company's).
The file and every row are always saved. Row problems don't fail the request; they show up in `errors` and set `status: "invalid"`. Returns `201` with the import:

```json
{"id": "…", "filename": "orders.csv", "status": "invalid", "rowCount": 12,
 "errors": [{"row": 4, "field": "value", "message": "Row 4: value must be a positive number."},
            {"row": 7, "field": "id", "message": "Row 7: order PO-2291 already exists."},
            {"row": null, "field": null, "message": "Missing columns: hsCode. Download the template."}],
 "preview": [{"rowNumber": 2, "id": "PO-2310", "product": "…", "supplier": "…", "destination": "…",
              "valueMinor": 1250000, "currency": "USD", "shipDate": "2026-11-03", "hsCode": "4412.33"}],
 "duplicateOfImportId": "…" | null, "createdAt": "…", "committedAt": null}
```
- `status`: `validated` (can be committed) | `invalid` | `committed`.
- `duplicateOfImportId`: an earlier import of this company with the same file checksum. This is a warning, not an error.
- File-level failures: `422 invalid_file_type` / `file_too_large` / `empty_file`.

### `GET /imports/{id}` (viewer)
Same shape as the upload response. The frontend calls it straight after the upload.

### `POST /imports/{id}/commit` (editor)
All or nothing: creates one order per row, each `awaiting_analysis` and linked to its row. Returns `{"importId": "…", "ordersCreated": 12}`.
- `409 already_committed`, `422 import_has_errors`, `409 orders_already_exist` (an order ID was added after validation).

Uploads never committed are deleted by `python -m app.cleanup_imports --older-than-days 30`.

## Playbook

Playbook page. Rules are only stored for now; they don't affect analysis yet. Every change records a new playbook revision. Each response returns its number in `meta.revision`.

### `GET /playbook/rules` (viewer)
`[{"id": "…", "text": "Flag any order where the projected margin drops below 8%.", "category": "Threshold", "enabled": true, "createdAt": "…"}]`. Loaded on every workspace load.

### `POST /playbook/rules` (editor)
`{"text": "…", "category": "Policy" | "Threshold" | "Supplier" | "Watchlist", "enabled": true}`. `text` is 1–500 chars. Returns `201` with the rule. "Add rule" form.

### `PATCH /playbook/rules/{id}` (editor)
Any of `text`, `category`, `enabled`. The UI sends only `{"enabled": <flipped>}` from the on/off switch.

### `DELETE /playbook/rules/{id}` (editor)
Returns `{"deleted": true}`. Delete button on a rule.

## Trade map

`#/workspace/map` (`frontend/src/TradeMap.tsx`, lazy-loaded). Live sessions only; the demo shows "Sign in to your company workspace".

### `GET /trade-map` (viewer)
Everything the map draws, in one call when the page opens:

| Key | Holds |
| --- | --- |
| `markets` | `code` (`EU`), name, hub point, `countryIds` (ISO numeric, matching world-atlas), `searchTerms` |
| `orders[]` | `order`, `placement` (city, country, market, location, `approximate` = placed at the country centre), `checks[]`, `gapCount` |
| `orders[].checks[]` | `requirementKey`, `title`, `level` (`supplier` / `shipment` / `check`), `status` (`on_file` / `missing` / `mismatch` / `prepare` / `check` / `unknown`), `note`, `source` |
| `checks[].source` | The shared regulation version behind the requirement and the sentence that requires it: `regulationTitle`, `officialId`, `documentId` (→ `GET /regulation-documents/{id}/file`), `versionNumber`, `sourceUrl`, `quote` |
| `suppliers[]` | From orders (matched by trimmed, lower-case name) + the supplier list. `id`/`documents` are `null` when the supplier is only named on orders |
| `sites[]` | Factories, ports, warehouses. `isRouteOrigin` marks the company's route start |
| `observations[]` | Satellite samples (`isSample: true`) with a GeoJSON `extent` and `nearby` suppliers/sites within `checkRadiusKm` (default 25). Order statuses never change because of them |
| `documentKinds`, `homeCountryIds`, `checkRadiusKm` | Labels, the countries to highlight, the flood check radius |

`gapCount` counts the checks that are `missing` or `mismatch`. The market panel ("changes to check") is built in the frontend from these checks.

### `GET /trade-map/compare?orderId=PO-2291&market=US` (viewer)
"What if this order went to another market?" Paperwork only.
```json
{"data": {"orderId": "PO-2291", "fromMarket": "EU", "toMarket": "US",
  "reuse":      [{"title": "FSC chain of custody", "note": "…", "tag": null}],
  "reevaluate": [{"title": "Lacey Act declaration", "note": "…", "tag": "New"}],
  "unknown":    [{"title": "Buyer requirements", "note": "…"}],
  "dropped":    ["EUDR due-diligence statement"]}}
```
- `422 unknown_market`, `422 same_market` (the order already goes there), `404` for an unknown order.

Called from the order's "What if" panel each time the target market changes. A new call cancels the previous one.

## Regulations

`#/workspace/regulations` (`frontend/src/Regulations.tsx`) lists regulations, uploads company texts, shows version history and downloads files with bearer authentication. Document deep links use `#/workspace/regulations/documents/{id}`; trade-map citations link there. Viewers can read/download; only owners/editors can upload.

A regulation has versions. Each version is one uploaded file. The list includes the company's own regulations plus shared official texts (`shared: true`, loaded by `seed_reference_data`: EUDR, Lacey Act, ISPM 15, …). Shared ones can be read and downloaded but not given new versions. Files live in Cloud Storage (`REGULATION_DOCUMENT_BUCKET`). Without storage access, uploads and downloads return `503 storage_not_configured`.

### `POST /regulation-documents` (editor, rate limited)
`multipart/form-data`: `file` (`.pdf` / `.html` / `.htm` / `.txt`, ≤4 MB, a PDF must start with `%PDF-`), `title` (1–300), optional `sourceUrl` (http(s), ≤2000, kept as a reference and never fetched), and either:
- no `regulationId` → a new regulation at version 1, with an optional `officialId` (≤100, e.g. `32023R1115`);
- `regulationId` → the next version of that company regulation (send no `officialId`).

Returns `201`:
```json
{"id": "…", "title": "EUDR consolidated text", "filename": "eudr.pdf", "contentType": "application/pdf",
 "sizeBytes": 812345, "checksum": "sha256…", "sourceUrl": "https://eur-lex.europa.eu/…",
 "regulationId": "…", "versionNumber": 2, "createdAt": "…"}
```
- `409 regulation_exists`: this company already uses the `officialId`. Upload the file as a new version of that regulation instead.
- `409 already_uploaded`: the same file is already a version of this regulation, or two uploads raced.
- `404`: `regulationId` is another company's or a shared regulation.
- `422 invalid_file_type` / `file_too_large` / `empty_file` / `invalid_pdf`.

### `GET /regulation-documents/{id}` (viewer)
Metadata of one version, same shape as the upload response. Works for the company's own and shared documents.

### `GET /regulation-documents/{id}/file` (viewer)
The file bytes. Always sent as `Content-Disposition: attachment` with `nosniff`, so uploaded HTML is never rendered on our domain. The trade map's `checks[].source.documentId` points here.

### `GET /regulations?officialId=` (viewer)
Every regulation, oldest first, with `versionCount` and `latestVersion`. With `officialId` it returns only the matching one, so an upload form can pre-select "new version of …".

### `GET /regulations/{id}` (viewer)
The regulation plus `versions[]`, newest first.

---

## Planned

Not built. Shapes follow the requirements and may change. Phases are the ones in REQUIREMENTS.md §5.

| Endpoint | Phase | Role | Does | Will be used by |
| --- | --- | --- | --- | --- |
| `GET /sources` | 2 | viewer | Rule sources and when each was last checked; fills `sourcesCheckedAt` | Dashboard "last checked" |
| `GET /regulations/{id}/requirements?version=` | 2 | viewer | The market requirements a version sets (the obligations), each with its quote, plus what changed from the previous version | Rule-change review, regulation page |
| `PATCH /market-requirements/{id}` | 2 | operator (owner for company requirements) | Edit a drafted requirement and mark it `draft` → `reviewed`. Only reviewed ones are checked and alert | Rule-change review |
| `POST /runs` | 2 | editor | Start an analysis (match → cost → plan → auditor). Saves the run and queues a Cloud Task. Returns the run ID | "Analyse" / rule-change flow, replacing today's simulated five-agent review |
| `POST /internal/runs/{id}/execute` | 2 | Cloud Tasks only (OIDC) | Does the run's work and saves each step. Called directly when running locally | Not the frontend |
| `GET /runs/{id}` | 2 | viewer | Run status and step summaries (no raw AI reasoning). Polled, so progress survives a refresh | Run progress panel |
| `GET /reports/{id}` | 2 | viewer | Report: affected orders, cost lines (`amountMinor` + currency), citations to rule clauses and CSV rows. `state`: `pass` / `needs_data` / `rejected` / `needs_human_review` | Order detail `exposures`, report view |
| `POST /reports/{id}/feedback` | 3 | viewer | Thumbs up/down + note on a report | Report view |
| `GET /orders/{id}/hs-suggestions`, `POST /hs-suggestions/{id}/accept` / `reject` | 2 | viewer / editor | AI-suggested HS codes for orders without one. Accepting sets the code and re-matches that order | Order detail (`needs_data`) |
| `POST /actions/drafts` | 3 | editor | Draft a supplier message from a `pass` report | "Draft email" |
| `PATCH /actions/{id}` | 3 | editor | Edit text or recipient. Resets an approved action to `draft` | Message editor |
| `POST /actions/{id}/approve` | 3 | owner | Records who, when and a hash of the exact text | "Approve" |
| `POST /actions/{id}/send` | 3 | owner | Sends once (`Idempotency-Key` header). Sandbox email in v1 | "Send" |
| `GET /actions/{id}` | 3 | viewer | State: `draft → approved → queued → sent → delivered`, or `failed` / `expired` / `cancelled` | Message status |
| `GET /audit-events` | 3 | owner | Who imported, edited, approved and sent what, and when | Audit log screen |
| `POST /contact` | 3 | none (rate limited) | Name, email and message to the team inbox | Landing page contact section (`#/contact`) |
| `GET /watch-sources`, `POST`, `PATCH /watch-sources/{id}` | 4 | viewer / editor | The company's rule sources (RSS, Federal Register, EUR-Lex) for the daily crawl | Sources settings |
| `POST /regulations/{id}/follow`, `DELETE …/follow` | 4 | editor | Follow a shared regulation. Matching uses only followed ones | Rule library |
| `GET /orders` for the AI | 4 | viewer | Same endpoint, called by `ai/server` with the user's token so chat can see orders | Chat |
