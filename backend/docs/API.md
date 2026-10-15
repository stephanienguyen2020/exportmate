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
| 429 | `rate_limited` | Per-user hourly limit reached, counted per instance: uploads 60, analysis runs 60 |
| 503 | `ai_unavailable` / `ai_not_configured` | An AI step (Gemini) failed or isn't set up (`GOOGLE_CLOUD_PROJECT`). Nothing was saved; try again |

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
| `GET /playbook/rules` | viewer | Every workspace load; `ai/server` chat (`get_playbook`) |
| `POST /playbook/rules` | editor | Playbook: add rule |
| `PATCH /playbook/rules/{id}` | editor | Playbook: on/off toggle |
| `DELETE /playbook/rules/{id}` | editor | Playbook: delete |
| `GET /trade-map` | viewer | Trade map; `ai/server` chat (`query_orders`) |
| `GET /trade-map/compare` | viewer | Trade map: "What if" panel |
| `POST /suppliers` | editor | Trade map: "Add supplier" / "Add a supplier record" |
| `PATCH /suppliers/{id}` | editor | Trade map: "Edit supplier" |
| `DELETE /suppliers/{id}` | editor | Trade map: "Delete supplier" |
| `POST /sites` | editor | Trade map: "Add site" |
| `PATCH /sites/{id}` | editor | Trade map: "Edit site" |
| `DELETE /sites/{id}` | editor | Trade map: "Delete site" |
| `POST /report-drafts` | viewer | Order detail: "Prepare report"; Reports: "Generate company report" |
| `GET /report-drafts` | viewer | Reports: your reports |
| `GET /report-drafts/{id}` | viewer (author) | Report editor |
| `PATCH /report-drafts/{id}` | viewer (author) | Report editor: save (also before preview, download, email) |
| `GET /report-drafts/{id}/pdf` | viewer (author) | Report editor: "Preview PDF", "Download PDF" |
| `POST /report-drafts/{id}/email` | editor (author) | Report editor: "Email report" |
| `POST /regulation-documents` | editor | Regulation library: add regulation / version |
| `GET /regulation-documents/{id}` | viewer | Regulation library |
| `GET /regulation-documents/{id}/file` | viewer | Regulation library |
| `GET /regulations` | viewer | Regulation library |
| `GET /regulations/{id}` | viewer | Regulation library |
| `GET /playbook/fields` | viewer | Not yet (playbook rule form) |
| `GET /company/cost-settings` | viewer | Not yet (settings, report cost lines) |
| `PATCH /company/cost-settings` | owner | Not yet (settings) |
| `POST /runs` | editor | Not yet ("Analyse", replacing the simulated five-agent review) |
| `GET /runs/{id}` | viewer | Not yet (run panel) |
| `GET /reports/{id}` | viewer | Not yet (report view) |
| `POST /suppliers/{id}/documents` | editor | Not yet (supplier panel) |
| `POST /supplier-documents/{id}/confirm` | editor | Not yet (supplier panel) |
| [Planned](#planned) | | Phases 3–4 |

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
- `sourcesCheckedAt` is always `null` until the crawler exists (phase 4, `GET /sources`). The dashboard takes its scan time from `ai/server` `/api/impacts`.

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
  "exposures": [{"reportId": "…", "requirementKey": "geolocation", "title": "Plot-level geolocation",
                  "status": "missing", "note": "Not on file from Binh Phu Wood.", "source": {…}}]}}
```
`source` is the CSV row the order came from, or `null` for seeded orders. `exposures` are the `missing` and `mismatch` findings of the order's latest report (`GET /reports/{id}`); empty before its first run.
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

Playbook page. Every change records a new playbook revision. Each response returns its number in `meta.revision`. A rule with `when` and `then` is **checked** by every analysis run; one without them is stored only (REQUIREMENTS.md §4.4).

```json
{"id": "…", "text": "Problems over USD 2,000 go to the owner", "category": "Threshold", "enabled": true,
 "when": [{"field": "estimated_cost", "op": "greater_than", "value": {"amountMinor": 200000, "currency": "USD"}}],
 "then": {"action": "owner_review", "note": null},
 "checked": true, "createdAt": "…"}
```

### `GET /playbook/rules` (viewer)
Every live rule in the shape above. Loaded on every workspace load.

### `POST /playbook/rules` (editor)
`{"text": "…", "category": "Policy" | "Threshold" | "Supplier" | "Watchlist", "enabled": true, "when": [...], "then": {...}}`. `text` is 1–500 chars; `when` (1–10 conditions) and `then` are optional but go together. Returns `201`. The frontend's "Add rule" form sends only text and category today.
- `422 invalid_rule` with the failing path, e.g. `{"when.0.field": "Unknown field. Use one of: …"}`: unknown field, a comparison the field doesn't allow, a value of the wrong type, an unknown market or document kind, or only one of `when`/`then`.

### `PATCH /playbook/rules/{id}` (editor)
Any of `text`, `category`, `enabled`, and `when` + `then` together (`null` for both makes the rule stored only). The UI sends only `{"enabled": <flipped>}` from the on/off switch.

### `DELETE /playbook/rules/{id}` (editor)
Returns `{"deleted": true}`. Delete button on a rule.

### `GET /playbook/fields` (viewer)
What the rule form's dropdowns offer:
```json
{"fields": [{"key": "days_until_ship", "label": "Days until ship date", "type": "number",
             "ops": {"less_than": "less than", "greater_than": "more than", "equals": "is"}, "options": null},
            {"key": "market", "label": "Market", "type": "text", "ops": {…},
             "options": [{"value": "EU", "label": "European Union"}, …]}, …],
 "actions": {"flag": "Add a note to the report", "owner_review": "…", "block": "…"},
 "noValueOps": ["is_empty", "is_not_empty"]}
```
Fields: `market`, `supplier`, `hs_code`, `order_value`, `days_until_ship`, `missing_documents`, `estimated_cost` (the problems' cost, without duties). Money values are `{"amountMinor", "currency"}` and only compare with amounts in the same currency.

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
| `suppliers[]` | From orders (matched by trimmed, lower-case name) + the supplier list. `id`/`documents` are `null` when the supplier is only named on orders. A document has `kind`, `detail`, `standards`, `documentNumber`, `issuer`, `expiresOn` (typed in or read from an upload) and `fromUpload` |
| `sites[]` | Factories, ports, warehouses. `isRouteOrigin` marks the company's route start |
| `observations[]` | Satellite samples (`isSample: true`) with a GeoJSON `extent` and `nearby` suppliers/sites within `checkRadiusKm` (default 25). Order statuses never change because of them |
| `documentKinds`, `homeCountryIds`, `checkRadiusKm` | Labels, the countries to highlight, the flood check radius |
| `countries` | `code` (alpha-2), `numericCode` (world-atlas id), `name`: the countries a supplier or site can be in. Includes sourcing countries outside any market (Laos, Cambodia, Thailand, …) |
| `suppliers[].country`, `sites[].country` | An alpha-2 code from `countries`, or `null` |
| `sites[].id`, `sites[].key` | `id` is for `PATCH`/`DELETE /sites/{id}`; `key` is made from the name, never changes, and is what observations' `nearby[].ref` uses |

`nearby[].distanceKm` estimates distance to the mapped polygon (including holes) using a local equirectangular projection. The proximity threshold is applied before rounding up to whole kilometres; zero means on or inside the extent. It is a screening estimate, not a survey measurement. The dashed overview circle is an approximate search-area illustration.

A supplier document that expires before the order's ship date is a `mismatch`. `gapCount` counts the checks that are `missing` or `mismatch`. The market panel ("changes to check") is built in the frontend from these checks.

The assistant's `query_orders` tool (`ai/server/orders.js`) also reads this route, with the chatting user's own token, to answer questions about the company's orders and their checklists.

### `GET /trade-map/compare` (viewer)
One what-if at a time. Send exactly one of `market`, `shipDate`, or `via`.

`?orderId=PO-2291&market=US` — another market. Paperwork only.
```json
{"data": {"orderId": "PO-2291", "fromMarket": "EU", "toMarket": "US",
  "reuse":      [{"title": "FSC chain of custody", "note": "…", "tag": null}],
  "reevaluate": [{"title": "Lacey Act declaration", "note": "…", "tag": "New"}],
  "unknown":    [{"title": "Buyer requirements", "note": "…"}],
  "dropped":    ["EUDR due-diligence statement"]}}
```
`reuse` means matching supplier records are on file for review; it does not establish validity or shipment coverage. Shipment requirements always stay in `reevaluate`, even when the form is unchanged (`tag: "Prepare"`). Other tags are `New` and `Changes`. `dropped` means absent from the target checklist, not legally unnecessary.

- `422 unknown_market`, `422 same_market` (the order already goes there), `404` for an unknown order.
- `422 invalid_input` when the call sends none of, or more than one of, `market`, `shipDate`, and `via`.

`?orderId=PO-2291&shipDate=2027-02-01` compares the planned ship date with that day. `kind` is `ship_date`. Lines whose `effectiveOn` falls between the two dates are in `reevaluate` (`tag: "New"` when the new date is the one that brings them into force). A `changesOn` date between them is `tag: "Changes"`. Unchanged lines are evaluated against supplier evidence: only matching records enter `reuse`; missing or mismatched documents, shipment paperwork and manual checks stay in `reevaluate`, and absent supplier records stay in `unknown`. Arrival time and the buyer's window stay in `unknown`. `422 same_date` when the date is already the planned one.

`?orderId=PO-2291&via=SG` compares a routing. `via` is `direct`, `SG`, `MY`, `HK`, `AE`, or `LK`. `kind` is `route`. `routeSensitive` checklist lines (origin proofs) go to `reevaluate` when there is an intermediate stop. `routePoints` contains the ordered origin, optional stop and actual order destination used for both rendering and distance calculation. It is empty if an endpoint or stop cannot be located. `distanceKm` is the great-circle length of those segments; `assumptions` says it is not a voyage or a freight quote. Freight, sailing time, and congestion stay in `unknown`. Unchanged requirements use the same evidence classification as the ship-date comparison, including direct routes. `422 unknown_route`, `422 same_route` when the stop is already the destination country.

Checklists are scoped by HS prefix: wood lines (chapters 44 and furniture 9401/9403), food (chapters 01–23), textiles (50–63), and listed electronics headings. A prefix-less line, such as proof of origin or ISPM 15 packaging, still applies across those products. Each line still cites an official text.

Called from the order's "What if" panel each time the market, date, or route changes. A new call cancels the previous one.

### Suppliers and sites (editor)
Editors enter them in the map's side panel; viewers don't see the controls. The location comes from a click on the 2D map (which also suggests the country) or from typed `latitude, longitude`. After a save or delete the page reloads `GET /trade-map`, so order checks and flood proximity are recomputed. Each change writes an audit event (`supplier.created|updated|deleted`, `company_site.created|updated|deleted`).

`POST /suppliers` → `201`:
```json
{"name": "Dong Nai Veneer", "place": "Bien Hoa, Dong Nai", "country": "VN",
 "location": {"latitude": 10.95, "longitude": 106.82}, "supplies": "Acacia veneer",
 "documents": [{"kind": "formaldehyde", "detail": "Test report, May 2026", "standards": ["EN 717-1"]}]}
```
Only `name` (1–300) is required. `place` ≤200, `supplies` ≤1000 (blank is stored as `null`), `country` an alpha-2 code from `countries` (`UK` is read as `GB`), `location` −90..90 / −180..180, up to 20 `documents`, one per `kind` from `documentKinds` (`detail` 1–500, up to 10 `standards`, optional `documentNumber` ≤100, `issuer` ≤200, `expiresOn` `YYYY-MM-DD`). A typed document and one confirmed from an upload (`POST /supplier-documents/{id}/confirm`) are the same record; a kind kept in the list keeps its upload link (`fromUpload`). Returns the supplier with `id` and labelled `documents`.
- `409 supplier_exists`: the company has a supplier with the same name, ignoring case and spacing. Orders match suppliers on that key, so a renamed supplier stops matching orders written with the old name.
- `422 invalid_input` with `fieldErrors.country` / `fieldErrors.documents` for an unknown country or document kind.

`PATCH /suppliers/{id}` changes only the fields sent; `null` clears `place`, `country`, `location`, `supplies`. `documents` replaces the whole list (send `[]` to clear it). `name` and `documents` can't be `null`. Same errors as `POST`.

`DELETE /suppliers/{id}` → `{"deleted": true}`. Its documents go with it; its orders stay, named on the order without a record (supplier checks become `unknown`).

`POST /sites` → `201`:
```json
{"kind": "warehouse", "name": "Da Nang warehouse", "shortName": "Da Nang", "place": "Tien Sa port, Da Nang",
 "country": "VN", "location": {"latitude": 16.12, "longitude": 108.21}, "note": "", "isRouteOrigin": false}
```
`kind` (`factory` / `port` / `warehouse`), `name` and `place` (1–200) and `location` are required. `shortName` (≤60, the map label) defaults to the name; `note` ≤1000. The `key` is made from the name (`da-nang-warehouse`, then `-2`, …) and never changes. At most one site is the route origin: `isRouteOrigin: true` moves it from any other site. Returns the site in the `sites[]` shape.

`PATCH /sites/{id}` changes only the fields sent; only `country` can be `null`. `DELETE /sites/{id}` → `{"deleted": true}`; deleting the route origin leaves the map to start routes from the company profile's origin.

Both: `404` for another company's supplier or site.

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

## Cost settings

The numbers analysis uses when a regulation doesn't give one (REQUIREMENTS.md §4.6 step 3). Shared defaults are seeded (`reference.json` `costDefaults`); a company can set its own.

### `GET /company/cost-settings` (viewer)
```json
[{"key": "delay_per_day", "label": "Delay: cost of each day an order waits (storage, late fees)",
  "unit": "USD", "value": 35000, "source": "company_setting", "defaultUnit": "USD", "defaultValue": 20000},
 {"key": "supplier_lead_days", "label": "Days a supplier needs to send a new document",
  "unit": "days", "value": 14, "source": "default", "defaultUnit": "days", "defaultValue": 14}, …]
```
Keys: `delay_per_day`, `missing_document`, `new_test` (money: `value` in hundredths of `unit`), `supplier_lead_days` (`unit` `days`).

### `PATCH /company/cost-settings` (owner)
`{"settings": [{"key": "delay_per_day", "value": 35000, "unit": "USD"}]}`. `value: null` goes back to the default. A money setting may change currency; a days setting can't. Returns the full list. `422` for an unknown key or a bad unit.

## Analysis (runs and reports)

A run checks orders against the market requirements, prices the problems, applies the checked playbook rules, suggests one action and audits the result (REQUIREMENTS.md §4.6). Plain code, no AI: it finishes inside the request.

### `POST /runs` (editor, rate limited)
Body optional: `{"orderIds": ["PO-2291"]}` (default: every order). Updates each order's `status` and returns `201` with the run:
```json
{"id": "…", "status": "done", "orderCount": 4, "playbookRevision": 3,
 "steps": [{"name": "relevance", "summary": "3 of 4 orders ship to a market with a checklist (EU, US)."},
           {"name": "exposure", "summary": "1 exposed, 1 clear, 2 need data. Checked against 30 market requirements."},
           {"name": "cost", "summary": "Estimated cost: USD 14,775.00."},
           {"name": "playbook", "summary": "2 checked rules (playbook revision 3) fired 2 times. …"},
           {"name": "plan", "summary": "4 orders have a suggested action."},
           {"name": "auditor", "summary": "4 of 4 reports passed the checks; 1 go to human review."}],
 "costSettings": [ …the values used… ], "error": null, "createdAt": "…", "finishedAt": "…",
 "reports": [{"id": "…", "orderId": "PO-2291", "state": "pass", "orderStatus": "exposed", "blocked": false,
              "costTotals": {"USD": 120000}}]}
```
- `422 unknown_orders`, `422 no_orders`. `500 analysis_failed`: the run is saved as `failed` and nothing else changes.

### `GET /runs/{id}` (viewer)
The same shape. Step summaries never include AI reasoning.

### `GET /reports/{id}` (viewer)
One order's report. Stored as it was written, so it reads the same after requirements, rules or settings change.

| Key | Holds |
| --- | --- |
| `state` | `pass`, `needs_data` (no checklist for the destination, or no supplier record), `needs_human_review` (an `owner_review` rule fired or the audit failed), `rejected` (reserved) |
| `orderStatus`, `blocked` | What the order became (`exposed` / `clear` / `needs_data`); `blocked` when a `block` rule fired |
| `order`, `orderSource` | The order as analysed and its CSV row (`importId`, `rowNumber`) |
| `findings[]` | Every requirement checked, as in the trade map's `checks[]`, each with its source and quote |
| `costLines[]` | `kind` (`missing_document` / `new_test` / `delay` / `duty`), `label`, `quantity`, `unitAmountMinor` or `baseAmountMinor` + `ratePercent`, `amountMinor`, `currency`, `formula` ("4 days × USD 200.00"), `basis[]` (`regulation` with its source, `company_setting` or `default`) |
| `costTotals`, `problemCostTotals` | By currency; the second leaves out duties (what playbook rules on `estimated_cost` compare) |
| `unpricedCosts[]` | Duties the regulation states but whose rate changes on or before the ship date (`changesOn`): `label`, `reason`, `source`, no amount, so the report never shows a rate it knows may be wrong |
| `rulesFired[]`, `rulesNotChecked` | Checked rules that fired (`ruleId`, `text`, `action`, `note`, `conditions` in words); enabled rules that are stored only |
| `suggestedAction` | `kind` (`complete_data` / `request_documents` / `move_ship_date` / `recheck_landed_cost` / `none`), `text`, `requestBy` |
| `audit` | `passed`, `problems[]`: every finding has a quote, every cost line re-computes and names its basis, totals add up, every rule exists |
| `missingData`, `daysUntilShip`, `market` | What's missing, days to the ship date at run time, the market |

## Supplier documents

A supplier's certificate uploaded as a file: AI reads it, a person confirms the fields, then it counts in the trade map and analysis.

### `POST /suppliers/{id}/documents` (editor, rate limited, AI)
`multipart/form-data` with `file`: `.pdf`, `.png`, `.jpg`/`.jpeg`, ≤4 MB, checked by its first bytes. The file is saved in Cloud Storage and Gemini reads it. Returns `201` with the draft:
```json
{"id": "…", "supplierId": "…", "filename": "geo.pdf", "contentType": "application/pdf", "sizeBytes": 51234,
 "status": "draft", "createdAt": "…", "confirmedAt": null,
 "extracted": {"kind": "geolocation", "documentNumber": "GEO-2026-118", "issuer": "…",
               "issuedOn": "2026-09-01", "expiresOn": "2027-10-14", "standards": [],
               "detail": "Plot coordinates for the 2026 acacia harvest, 4 plots", "notes": null}}
```
A `kind` that isn't a known document kind and dates that aren't `YYYY-MM-DD` come back `null`. Nothing is saved when the AI step fails (`503`). `404` for another company's supplier; `422 invalid_file_type` / `file_too_large` / `empty_file` / `invalid_file`.

### `POST /supplier-documents/{id}/confirm` (editor)
`{id}` is the upload. Body: the fields as the person checked them: `kind`, `detail`, `standards`, `documentNumber`, `issuer`, `expiresOn`. Writes the supplier's document of that kind (replacing an older one) and returns it with its `uploadId`. `409 already_confirmed`, `422` for an unknown kind.

---

## Reports

A report is generated into a draft that only its author sees (`report_drafts`). The draft keeps the generated report (`original`) and an editable copy (`content`). Everything in `content` can be edited, but the PDF shades every line that differs from `original`, notes per section what was changed, added or left out and by whom, and says "contains edits by <name>" in the footer. Sending locks the draft. An order report is the shareable copy of the order's latest analysis report (`GET /reports/{id}`): analysis decides statuses and costs; this repeats them for a reader outside the app.

Content shape (camelCase): `{title, subtitle, summary, sections: [{id, layout: "facts"|"table"|"sources", heading, note, empty, columns, widths, toneColumn, included, rows: [{id, cells: [..one per column..], tone: "gap"|"warn"|null, included}]}]}`. A cell whose last line is only a URL renders as a link (`Publisher\nhttps://…`).

### `POST /report-drafts` (viewer)
`{"kind": "order", "orderId": "PO-2291"}` or `{"kind": "company", "days": 30}` (7–180). `201` with the draft:
```json
{"data": {"id": "…", "kind": "company", "title": "What's happening and what it affects", "scope": {"days": 30},
  "createdAt": "…", "updatedAt": "…", "sentAt": null, "sentTo": null,
  "companyName": "Binh Duong Wood Co.", "preparedBy": "Lan",
  "content": {…}, "original": {…},
  "edits": {"header": false, "sections": 0, "rowsEdited": 0, "rowsAdded": 0, "rowsRemoved": 0}}}
```
- Order: order facts, the document checklist exactly as `GET /trade-map` checks it, what the order's latest analysis found (`analysis`: next step, estimated cost, review state, playbook rules fired, missing data; `costs`: each cost line with its formula and basis, and unpriced duties), cited sources with quotes, the CSV row. Preparing a report never starts an analysis (that changes order statuses and needs an editor); without one the sections say "Not analysed yet", and they say so when the checklist has changed since the analysis. `404` for another company's order.
- Company: at a glance; checklist lines in the markets the company ships to that take effect or change in the next `days`, with the open orders shipping on or after that date; News watch alerts (high and medium, last `days`), read from the AI service's `GET /api/impacts` with the caller's token (`AI_SERVICE_URL`; if it can't be reached the section says so); floods within the check radius of suppliers and sites (last `days`); regulation versions added in the last `days` and the open orders whose checklists cite that regulation; open orders with document gaps; suppliers to follow up; sources.

### `GET /report-drafts` (viewer)
The caller's 30 most recently updated reports (summary fields only).

### `GET /report-drafts/{id}` (viewer, author only)
Another member's draft is `404`.

### `PATCH /report-drafts/{id}` (viewer, author only)
`{"content": {…}}` replaces the content. Sections can't be added, removed or reordered, and their `layout`, `widths`, `toneColumn` and column count can't change (`422 invalid_report`); generated lines are left out with `included: false`, not deleted. New lines need a new `id`. `409 report_already_sent` once sent.

### `GET /report-drafts/{id}/pdf` (viewer, author only)
The PDF of the saved content, `inline` for the preview; `?download=true` makes it an attachment.

### `POST /report-drafts/{id}/email` (editor, author only, rate limited)
```json
{"to": ["buyer@example.com"], "message": "Optional note, ≤1000 chars"}
```
```json
{"data": {"recipients": ["buyer@example.com"], "sandbox": false, "sentAt": "2026-10-15T09:12:00Z"}}
```
- `to`: 1–5 plain addresses (no display names), trimmed and de-duplicated. Replies go to the sender's own email. Subject: `<company>: <title>`.
- Optional `Idempotency-Key` header (the frontend sends a new one per dialog): Resend sends once per key for 24 hours. The draft is locked (`SELECT … FOR UPDATE`) while sending; a second send is `409 report_already_sent`.
- `sandbox: true` means `RESEND_API_KEY` isn't set: built and audited, not delivered.
- Writes a `report.emailed` audit event with the recipients, note and edit counts (logs only carry counts).
- `422 invalid_input` (bad addresses), `422 email_rejected`, `429 rate_limited` (`REPORT_EMAILS_PER_HOUR`, default 20 per user), `502 email_failed`, `503 email_unavailable`.

## Planned

Not built. Shapes follow the requirements and may change. Phases are the ones in REQUIREMENTS.md §5. Phase 2 is mostly built (above; the frontend doesn't call the new endpoints yet). Requirement drafting and HS code suggestions wait for retrieval (RAG).

| Endpoint | Phase | Role | Does | Will be used by |
| --- | --- | --- | --- | --- |
| `GET /sources` | 4 | viewer | Rule sources the crawler watches and when each was last checked; fills `sourcesCheckedAt` | Dashboard "last checked" |
| `POST /reports/{id}/feedback` | 3 | viewer | Thumbs up/down + note on a report | Report view |
| `GET /regulations/{id}/requirements?version=` | 2 (later, with RAG) | viewer | The market requirements a version sets, each with its quote, plus what changed from the previous version | Rule-change review, regulation page |
| `POST /regulation-documents/{id}/requirements` | 2 (later, with RAG) | editor | AI drafts the market requirements of one version of the company's own regulation; quotes checked against the text (PDF text too); long texts searched by section | Rule-change review |
| `PATCH /market-requirements/{id}` | 2 (later, with RAG) | owner | Edit a drafted requirement and mark it `reviewed` / `rejected`. Only reviewed ones are checked | Rule-change review |
| `POST /orders/{id}/hs-suggestions`, `GET …`, `POST /hs-suggestions/{id}/accept` / `reject` | 2 (later, with RAG) | editor / viewer | AI suggests HS codes for orders without one, from the company's past orders and the HS headings it retrieves. Accepting sets the code and analyses the order again. Needs empty `hsCode` cells allowed in the CSV | Order detail (`needs_data`) |
| `POST /internal/runs/{id}/execute` | later | Cloud Tasks only (OIDC) | Runs a run's work outside the request, once a step waits on AI (e.g. the phase 3 message draft). Phase 2 runs finish inside `POST /runs` | Not the frontend |
| `POST /actions/drafts` | 3 | editor | AI drafts a supplier message from a `pass` report that isn't `blocked` | "Draft email" |
| `PATCH /actions/{id}` | 3 | editor | Edit text or recipient. Resets an approved action to `draft` | Message editor |
| `POST /actions/{id}/approve` | 3 | owner | Records who, when and a hash of the exact text | "Approve" |
| `POST /actions/{id}/send` | 3 | owner | Sends once (`Idempotency-Key` header). Sandbox email in v1 | "Send" |
| `GET /actions/{id}` | 3 | viewer | State: `draft → approved → queued → sent → delivered`, or `failed` / `expired` / `cancelled` | Message status |
| `GET /audit-events` | 3 | owner | Who imported, edited, approved and sent what, and when | Audit log screen |
| `POST /contact` | 3 | none (rate limited) | Name, email and message to the team inbox | Landing page contact section (`#/contact`) |
| `GET /watch-sources`, `POST`, `PATCH /watch-sources/{id}` | 4 | viewer / editor | The company's rule sources (RSS, Federal Register, EUR-Lex) for the daily crawl | Sources settings |
| `POST /regulations/{id}/follow`, `DELETE …/follow` | 4 | editor | Follow a shared regulation. Matching uses only followed ones | Rule library |
| `GET /orders` for the AI | 4 | viewer | Same endpoint, called by `ai/server` with the user's token so chat can see orders | Chat |
