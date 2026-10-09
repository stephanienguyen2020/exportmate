# ExportMate — backend implementation plan

## 1. Outcome and current state

Connect the completed frontend to a multi-tenant service that ingests a firm's orders and materials, detects relevant regulatory changes, prices order-level exposure, and produces an auditable recommendation requiring human approval.

This plan follows the supplied **PRD v0.1 (19 September 2026)** and **Architecture**. Their demo narrative is a product scenario, not evidence of current law. Select and independently verify the actual official rule document before implementing a live compliance demo.

### Already built
- React/TypeScript/Vite frontend with Overview, Orders, Rule Watch, Data Room, Playbook, and order-impact detail.
- Local CSV validation and preview; local rules and orders persisted in browser storage.
- Twelve fictional orders, two sample exposures, five-stage simulated agent flow with an auditor rejection.
- Editable supplier-message draft and explicit demo confirmation; no external message transmission.
- Separate maker USD and buyer SGD fixture amounts. The buyer toggle is a preview, not authentication or tenant switching.

### Still frontend-only
- All rule coverage, dates, status, costs, and citations are fixtures.
- Imported orders show **Awaiting analysis**. They are not legally cleared by import.
- Playbook rules are stored but are not evaluated against orders yet.
- A message confirmation does not resolve missing evidence.
- The sample quote must be replaced by an exact excerpt of an official, versioned source.
- No authentication, crawling, agent execution, document OCR, email/Zalo delivery, server persistence, or production hosting has been implemented.

## 2. MVP boundary and acceptance criteria

Start with one tenant for a Vietnamese wood manufacturer, a separately isolated Singapore buyer tenant, one verified EU obligation, and the VN → SG → EU corridor. Preserve an extensible jurisdiction model.

The first production-shaped vertical slice must:
1. Authenticate the user and authorize their tenant membership.
2. Validate and ingest an orders CSV with row-level provenance.
3. Associate order lines with BOM, materials, supplier lots, and origin records.
4. Ingest two versions of a verified official rule document and identify the clause change.
5. Match obligations to the exact open orders using product, HS code, material, origin and final destination.
6. Compute costs with deterministic arithmetic and explicit assumptions.
7. Block every recommendation lacking required source and internal-data evidence.
8. Present an editable message, capture approval, and submit it once to a sandbox channel.
9. Record delivery status separately from approval and exposure resolution.
10. Return the same persisted state after refresh or sign-in on another device.

Target under 60 seconds for the prepared demo pipeline; under 24 hours from publication to alert for configured sources. Treat these as service targets until measured.

## 3. Proposed service architecture

Use the Google Cloud architecture requested in the source documents. Verify current service APIs, quotas, regional availability, and Gemini model availability when beginning implementation; keep model IDs in configuration.

```text
React frontend (Firebase Hosting)
  └─ Firebase Authentication ID token
      └─ API service (Cloud Run, proposed Python/FastAPI)
          ├─ Firestore: tenant records, imports, jobs, reports, actions, playbooks
          ├─ Cloud Storage: original uploads and source document versions
          ├─ Pub/Sub: import-ready and obligation-changed events
          └─ ADK reasoning worker (Cloud Run)
               relevance → exposure → cost → plan → auditor

Cloud Scheduler → Cloud Run crawler jobs → Cloud Storage versioned raw documents
  → document normalization (Document AI for scans; Gemini for extraction)
  → schema validation + reviewed obligation versions
  → BigQuery obligation relations → Pub/Sub → tenant reasoning runs

Approved action → transactional outbox → Cloud Functions/Cloud Run delivery worker
  → Zalo OA / email provider → verified callback → action delivery status
```

For the hackathon, run the API and reasoning worker from one codebase with separate service entry points. Avoid adding infrastructure that is not used by the first vertical slice. BigQuery supports the shared obligation layer; Firestore serves interactive tenant data. Defer Vector Search until retrieval demonstrably needs it.

## 4. Entities, provenance, and tenant boundaries

Use server-generated IDs and UTC timestamps. Store money as integer minor units plus ISO currency, never floating-point dollars. Preserve source units and conversion metadata. Do not infer a final destination solely from a Singapore intermediary.

| Entity | Essential fields |
| --- | --- |
| Tenant | id, legalName, role, country, timezone, currencies, settings |
| Membership | userId, tenantId, role: owner/editor/viewer, status |
| Import | tenantId, objectKey, filename, checksum, status, schemaVersion, rowCount, validationErrors, createdBy |
| SourceRow | importId, sheet, rowNumber, rawCells, normalizedFields, rowHash |
| Order | tenantId, externalId, buyerId, status, destination, finalDestination, shipAt, currency, valueMinor, sourceRowId |
| OrderLine | orderId, productId, HS code/version, quantity, unit, unitPriceMinor, BOM version, lotIds, sourceRowId |
| Material / BOM | productId, materialId, inputQuantity, unit, materialOrigin, lotId, sourceRowId |
| Supplier / Lot | tenantId, supplierId, origin country, evidence document IDs, geolocation status, sourceRowId |
| SourceDocument | jurisdiction, official URL, fetchedAt, contentHash, version, previousVersionId, storageObject, language, publicationDate |
| Obligation | sourceVersionId, clause locator, exact excerpt, HS codes, material, jurisdictions, effectiveAt, applicability predicates, reviewStatus, supersedesId |
| PlaybookVersion | tenantId, revision, rules, createdBy, createdAt, enabled, compiledPredicates, humanReadableText |
| ReasoningRun | tenantId, triggerEventId, snapshot versions, state, agent steps, errors, startedAt, finishedAt |
| Exposure | tenantId, orderId, obligationVersionId, matched lines, state, evidenceIds, deadline, missingFields |
| ImpactReport | exposureIds, cost lines, amountMinor, currency, assumptions, confidence, citations, auditor verdict, reportVersion |
| Action | tenantId, reportVersion, channel, recipientId, draft, draftHash, state, approval actor/time, providerMessageId, delivery status |
| AuditEvent | tenantId, actor, operation, objectId, before/after hashes, timestamp, correlationId |

Firestore hierarchy: `/tenants/{tenantId}/orders`, `/imports`, `/suppliers`, `/materials`, `/reports`, `/runs`, `/playbooks`, `/actions`, `/auditEvents`. Membership validation must happen in every API path. Tenant keys come from verified membership, never from an untrusted request body alone.

Maker and buyer reports must be calculated from each tenant's own records. A trade relationship does not grant access to another company's cost, supplier, or margin records. Introduce explicit, revocable sharing grants before implementing shared evidence.

## 5. HTTP contracts

Prefix `/api/v1`. Require authentication except health probes. Every business request uses an authorized tenant context. Return `{ data, meta }` on success and `{ error: { code, message, fieldErrors, requestId } }` on failure. Use 422 for validation, 403 for authorization, 409 for stale version/idempotency conflicts, and 429 for rate limits.

| Method / endpoint | Request / response and UI consumer |
| --- | --- |
| GET `/me` | User, memberships, authorized role; replaces local perspective toggle |
| GET `/overview` | Counts by status, exposure totals grouped by currency, nearest affected shipment, freshness |
| GET `/orders?status=&q=&cursor=` | Paginated order summaries, stable sorting, total count |
| GET `/orders/{id}` | Lines, supplier, provenance, exposures, latest approved report |
| POST `/imports/upload-url` | Filename/type/size/checksum → short-lived upload URL and importId |
| POST `/imports/{id}/validate` | Start parse → 202 with jobId; reject oversize/type mismatch |
| GET `/imports/{id}` | Validation state, column mapping, row preview, errors |
| POST `/imports/{id}/commit` | Explicit normalized schema mapping, expectedVersion, Idempotency-Key → 202 |
| GET `/sources` | Configured sources, last successful poll, freshness and failure state |
| POST `/documents/upload-url` | Staff-authorized regulation upload for demo/operator workflow |
| GET `/obligations/{id}` | Structured applicability, version, clause excerpt, source URL, diff |
| POST `/runs` | Trigger against import or reviewed obligation; restricted role; 202 |
| GET `/runs/{id}` | Persisted progress with safe user-visible step summaries |
| GET `/runs/{id}/events` | Authenticated stream, or use bounded polling with backoff |
| GET `/reports/{id}` | Cost lines, assumptions, cited evidence, audit verdict and recommended action |
| GET `/evidence/{id}` | Authorized citation metadata; short-lived object URL where appropriate |
| GET/POST `/playbook/rules` | List or create a rule; return new playbook revision |
| PATCH/DELETE `/playbook/rules/{id}` | Enable/update/remove; require expected revision; retain audit history |
| POST `/actions/drafts` | reportId, reportVersion, proposed channel → editable draft, recipient, expiry |
| POST `/actions/{id}/approve` | Approved text + expected draft version; bind actor, hash and reportVersion |
| POST `/actions/{id}/send` | Idempotency-Key; only valid approved drafts → 202 queued |
| GET `/actions/{id}` | queued/sent/delivered/failed and safe retry state |
| POST `/reports/{id}/feedback` | useful/dismissed + reason; optionally propose a playbook rule |

Example report shape:

```json
{
  "id": "report_123",
  "version": 1,
  "orderId": "order_2291",
  "state": "audited",
  "currency": "USD",
  "totalExposureMinor": 120000,
  "costLines": [
    {"kind": "documentation", "amountMinor": 40000, "assumptionId": "assumption_1"},
    {"kind": "delay", "days": 4, "dailyRateMinor": 20000, "amountMinor": 80000, "assumptionId": "assumption_2"}
  ],
  "citations": [
    {"kind": "legal", "sourceVersionId": "doc_v2", "clause": "verified-locator"},
    {"kind": "internal", "importId": "import_1", "rowNumber": 2, "rowHash": "..."}
  ],
  "auditor": {"verdict": "pass", "checks": ["source_exists", "row_exists", "math_matches"]}
}
```

These amounts reproduce the fictional UI; do not deploy them as universal legal costs. Buyer S$14,800 total exposure needs separate buyer PO/margin data. Never imply USD maker exposure converts to that number.

## 6. Import pipeline

1. Authorize upload and enforce file size, extension, MIME and actual file signature limits.
2. Store the original under an isolated tenant object prefix; checksum for duplicate detection.
3. Parse CSV/Excel in a worker with bounded row/column/file limits. Preserve HS codes as text, leading zeros, dates, currency and units.
4. Extract photographed slips through a multimodal/OCR path; retain confidence and original bounding boxes. Low-confidence fields require user review.
5. Show a column-mapping screen when headers differ; return errors for missing required data and ambiguous dates/decimal formats.
6. Validate order IDs, references, HS formatting, currencies, material joins, positive quantities and duplicate policy.
7. Preview normalized rows and require explicit commit. Apply the import atomically or in a recoverable batch with a manifest.
8. Mark new records `awaiting_analysis`; publish one idempotent import-ready event.
9. For updates, make overwrite/merge semantics explicit. Preserve history and re-run impacted reports after changes.

Initial input minimum: orders plus BOM and supplier origin/lot evidence. The current frontend's order-only CSV is sufficient for a UI demo, not full regulatory applicability.

## 7. Rule watching and obligation extraction

- Build one source adapter per jurisdiction with allowlisted official domains, polling cadence, parser and version strategy.
- Record publication and effective dates separately; alerts use last successful fetch and stale-source status.
- Compare document content hashes; avoid duplicate work for formatting-only changes where practical.
- Retain old and new versions and structured clause diffs. Support scanned PDFs and multilingual excerpts.
- Extract obligations into a strict schema: product/HS/material, origin/destination/transit predicates, obligation, exemptions, threshold, effective date, clause locator, source version and language.
- Validate extracted predicates and dates. Route ambiguous legal interpretation to manual review, not a confident alert.
- Publish only reviewed/validated obligation versions. Quarantine malformed output and retry transient failures with a dead-letter queue.
- Ingested PDFs/web pages are untrusted data. Instructions embedded in documents must never alter system policy, tool permissions, or delivery behavior.

## 8. Reasoning and auditor contract

The proposed ADK pipeline follows the five agents in the architecture. Keep financial calculations in deterministic tools; the model selects/explains inputs rather than inventing values.

1. **Relevance:** match tenant products, markets and playbook watchlists; irrelevant events stop here.
2. **Exposure:** join obligations → material/BOM/lot → order lines → destination/origin; emit matched predicates and source rows. Missing facts create `needs_data`, not `clear`.
3. **Cost:** compute duties, documentation, optional delay scenarios and landed-cost impact in typed functions. Show baseline, delta, units, exchange-rate source/time and assumptions. Avoid counting the same cost twice across related exposures.
4. **Plan:** suggest one feasible action from an allowlist and create a message draft. Apply owner policy and supplier lead times.
5. **Auditor:** check every factual claim against the exact document version/locator or tenant row snapshot; re-evaluate formulas; ensure action complies with playbook and has no ungrounded counterparty claims.

Audit states: `pass`, `needs_data`, `rejected`, `needs_human_review`. Persist rejection reasons and the corrected revision; cap repair attempts (e.g. two), then escalate. A rejected report cannot feed external alerts or action approval.

Persist concise evidence-based explanations and tool results for the UI. Do not expose private chain-of-thought. Pin input versions for reproducibility; invalidate drafts after a material report change.

## 9. Action approval and notification delivery

State machine: `draft → approved → queued → sent → delivered`, with `failed`, `expired`, and `cancelled` branches. Approval and delivery are distinct facts.

- Bind approval to tenant, user, recipient, channel, message text hash, report version and time.
- Editing the text or changing the recipient invalidates approval.
- Check auditor pass, current report version and membership again at send time.
- Insert the approved send request into a transactional outbox; use idempotency keys to avoid duplicate deliveries.
- Use provider delivery IDs and verify webhook signatures; tolerate duplicate/out-of-order callbacks.
- Retry only retryable failures, with backoff and a bounded attempt limit; surface permanent failures.
- Store tokens in Secret Manager; never ship provider credentials to the frontend.
- Confirm Zalo OA access/approval early. Use a provider sandbox email channel for the demo if unavailable, and label it.
- Never clear an exposure just because a message was sent. Require new evidence and a fresh audited analysis.
- Apply owner-configured red/yellow/green thresholds, digest cadence, quiet hours and alert caps (target fewer than five per week).

## 10. Frontend connection work

1. Add a typed `src/api/client.ts` and domain-specific modules for orders, reports, imports, rules and actions. Keep components independent of transport.
2. Replace browser-local reads with authenticated API calls and explicit loading/error/empty states; consider a query cache for invalidation and polling.
3. Replace hash-only tenant context with an authenticated workspace selector. Do not use the maker/buyer display switch as an access boundary.
4. Populate metrics from API aggregates, grouped by currency; compute dates from tenant timezone and current time.
5. Replace the rule demo timer with persisted job progress. Preserve a separate fixture mode behind explicit configuration.
6. Render verified source links with exact excerpts, document version, internal row/sheet and cost assumptions; make stale citations visible.
7. Replace CSV local commit with upload → parse → mapping/preview → confirmed commit.
8. Add photo/Excel/PDF import UI only when corresponding backend routes exist.
9. Connect message review to draft, approval and send endpoints. Show real provider states and retries.
10. Separate fixture and live environments visibly; never silently fall back from failed live requests to sample results.

## 11. Security and operations

- Verify ID tokens and authorization server-side on every endpoint. Test cross-tenant reads/writes, object URLs, streams, exports and background jobs.
- Enforce least-privilege service accounts; separate raw document access from user notification delivery.
- Use signed, short-lived URLs; validate downloads against tenant context; avoid sensitive data in logs.
- Apply CORS allowlists, rate limits, input bounds, upload malware scanning where appropriate and prompt-injection defenses.
- Maintain immutable audit records for imports, rule changes, approvals and sends. Define retention/deletion and backup/restore policies before accepting real firm data.
- Monitor source freshness, queue age, run duration, extraction failures, citation completeness, auditor rejection, notification failure and token cost.
- Give every run a correlation ID across API, worker and provider. Alert on stalled/dead-letter jobs and sources exceeding freshness targets.
- Infrastructure as code for projects/services, storage, Firestore rules/indexes, Pub/Sub topics, Scheduler, Cloud Run, IAM and secrets. Separate dev/demo/prod data and credentials.

## 12. Suggested implementation order

### Milestone A — foundations
- [ ] Confirm verified rule pair, seed orders/BOM/suppliers and channel availability.
- [ ] Create Google Cloud dev project, Firebase Auth, Firestore and Storage.
- [ ] Implement tenant membership, API skeleton, schemas, audit logging and money/date helpers.
- [ ] Seed maker and buyer independently; add cross-tenant authorization tests.

### Milestone B — first vertical slice
- [ ] Implement CSV upload, validation, provenance, preview and commit.
- [ ] Implement order list/detail, pending-analysis state and overview aggregates.
- [ ] Connect frontend auth, orders and Data Room to API.
- [ ] Add versioned manual source-document ingest and obligation schema validation.

### Milestone C — priced, cited reasoning
- [ ] Implement deterministic material/origin/order matching and cost calculations.
- [ ] Integrate configured Gemini models and ADK steps.
- [ ] Implement auditor gate, bounded repairs, run progress and safe reasoning summaries.
- [ ] Replace fixture impact views with report/evidence responses.
- [ ] Demonstrate one intentionally unsupported suggestion being blocked.

### Milestone D — action loop
- [ ] Add versioned playbook APIs and rule applicability.
- [ ] Implement drafts, approval, outbox, idempotent send and signed callbacks.
- [ ] Connect sandbox Zalo or email; prove double-click and retry cannot double-send.
- [ ] Add feedback and explicit suggested-rule creation.

### Milestone E — deployment and demo hardening
- [ ] Add the first scheduled official-source watcher and obligation event flow.
- [ ] Deploy API/worker to Cloud Run and built frontend to Firebase Hosting.
- [ ] Add logging/metrics, budgets, job retry handling and stale-source UI.
- [ ] Rehearse: import → rule change → 12 clear orders → 2 exposures → auditor rejection/repair → approved message.
- [ ] Run full acceptance suite and record known limitations.

P1 after the vertical slice: isolated buyer reports, cited Q&A, weekly report (max five ranked items), improved playbook compiler. P2: compliance calendar, new jurisdiction adapters, ERP connectors, vector retrieval.

## 13. Required tests before real data or messages

| Area | Meaningful cases |
| --- | --- |
| Applicability | Matching/nonmatching HS and material; indirect EU destination; origin ambiguity; effective-date boundaries; cancelled/shipped orders |
| Financials | Zero/negative inputs rejected; currency mismatch; rounding; overlapping exposure costs; explicit FX source; expected fixture total $2,400 |
| Imports | Quoted CSV, BOM/UTF-8, Excel leading zeros, ambiguous dates, duplicate retry, missing supplier joins, partial failure, large file |
| Citations | Missing clause, fabricated locator, changed document version, deleted row, wrong tenant row, numeric mismatch all block release |
| Tenancy | Guessed IDs, signed URLs, streams and jobs cannot leak another tenant's data |
| Approvals | Edited draft, stale report, revoked user, repeated sends and expired approval cannot bypass approval or duplicate delivery |
| Operations | Crawler failure, model timeout, invalid JSON, queue redelivery, provider outage, storage failure and restore |
| UI | Loading/empty/error states, pending analysis, currency labels, keyboard dialogs, mobile table scrolling, reconnect after job interruption |

## 14. Decisions to resolve before backend coding

- Exact official old/new rule pair and verified effective dates.
- Required minimal BOM/lot schema and who supplies plot-level information.
- Cloud region and data residency requirements.
- Buyer sharing permissions and the basis of its margin exposure formula.
- Zalo availability, notification fallback and approval expiry policy.
- Current available Gemini model IDs and cost limits.
- Legal expert escalation owner and review SLA.

These decisions should not block building the authenticated import/order/report skeleton. They do block representing the legal demo as current guidance or sending real alerts.

## Frontend account-flow implementation update

The UI now includes sign-in, sign-up, verification preview, recovery request, reset preview, three-step onboarding, profile/notification settings, sign-out, prototype privacy/terms, and a 404 page. See `ACCOUNT_AND_SITE_PLAN.md` for route details. A client-side session gate and browser-local profile adapter support the walkthrough; neither is a security boundary. Password fields are validated transiently and never persisted. No accounts, verification/reset emails, or actual password updates are performed.

Next integrations: replace `src/account-store.ts` with the verified authentication provider; preserve intended workspace routes; gate onboarding on confirmed verification; persist tenant profile/preferences server-side; revoke server sessions on logout; connect the contact draft form to rate-limited validated delivery; replace prototype legal information before accepting live customers.
