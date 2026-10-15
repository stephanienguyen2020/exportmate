# ExportMate — frontend gaps against the backend

Backend features that are built and tested but that the frontend doesn't use yet (checked against `frontend/src` on 15 October 2026). Endpoint details are in [API.md](API.md); the rules behind them in [REQUIREMENTS.md](REQUIREMENTS.md). None of these endpoints is called from `frontend/src/api.ts` yet.

| # | Screen | Backend ready | Frontend today | To build |
| --- | --- | --- | --- | --- |
| 1 | **Orders / Overview: "Analyse"** | `POST /runs`, `GET /runs/{id}` | Imported orders stay "Awaiting analysis". The rule-change review is a simulation in the browser-only demo ("available in the sample demo", `main.tsx`) | An "Analyse" button (editor) and a run panel: the 6 step summaries and each order's result. Then reload the orders and the overview so statuses and counts update |
| 2 | **Order detail: analysis report** | `GET /reports/{id}`; `GET /orders/{id}` returns `exposures` | `exposures` is typed `unknown[]` and never shown; the "Source and analysis" panel shows only the CSV row | The problems with their quotes, cost lines (formula and where each number came from), unpriced duties, playbook rules that fired, the suggested action, the audit result and the review state |
| 3 | **Order detail: HS code suggestions** | `POST` / `GET /orders/{id}/hs-suggestions`, `POST /hs-suggestions/{id}/accept`, `…/reject` | Nothing; an order without a code shows an empty HS code | For `needs_data` orders without a code: "Suggest HS code" → up to 3 cards (code, official wording, reason, "based on" PO-x or a tariff line) → Accept / Reject. Accepting returns the order's new analysis run |
| 4 | **Playbook: checked rules** | `GET /playbook/fields`; `when` / `then` on create and update; `checked` on each rule | Text and category only. Its notice says "order statuses don't use them yet", which is no longer true | A WHEN/THEN builder from `/playbook/fields` (field ▾, comparison ▾, a value input by type; action ▾ and a note), a "checked" / "not checked" badge per rule, and a corrected notice |
| 5 | **Settings: cost settings** | `GET` / `PATCH /company/cost-settings` (owner) | None | A table: label, default, the company's value (money with a currency, or days), "Reset to default". Read-only for editors and viewers |
| 6 | **Trade map: supplier certificate upload** | `POST /suppliers/{id}/documents`, `POST /supplier-documents/{id}/confirm` | Documents are typed in the supplier form (it already has number, issuer and expiry) | "Upload certificate" (PDF, PNG, JPEG) → a confirm form filled with what AI read (kind, number, issuer, dates, standards, notes) → Confirm. Mark documents that came from an upload and show their expiry |
| 7 | **Regulations: requirement review** | `POST /regulation-documents/{id}/requirements`, `GET /regulations/{id}/requirements`, `PATCH /market-requirements/{id}` (owner) | Library, versions, upload and download only | On a version of a company regulation: "Draft requirements" (editor) → the drafts with their quotes, flagging `quoteVerified: false` ("check against the file") and the `dropped` counts. Owner: edit, Approve, Reject. Show what changed from the previous version and whether the version is in force |
| 8 | **CSV upload preview** | Empty `hsCode` cells are accepted | An empty code shows with no explanation | A note on those rows: "No HS code: you can ask for a suggestion after import" |
| 9 | **Report editor** | The order report has new `analysis` and `costs` sections | Rendered by the generic section layout, so it already works | Check it visually; nothing required |

**Suggested order:** 1 and 2 first (they make analysis visible), then 3 and 5, then 4 and 6, then 7 (the largest; it needs an owner account to test).

**Not frontend, still open:** apply Terraform (the backend's Vertex AI role and `GOOGLE_CLOUD_PROJECT`) and deploy; the AI test set (REQUIREMENTS.md open question 22).

Update this list as screens are built; remove a row once its screen uses the endpoint.
