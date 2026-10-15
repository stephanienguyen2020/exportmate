# Frontend validation

Validated locally on 8 October 2026 with a production TypeScript/Vite build and headless Chrome browser checks.

## Passed
- `npm run build`: TypeScript compilation and production bundling.
- Desktop overview: screenshot reviewed at 1440 px; no page overflow.
- Order search: a PO query reduces the table to the matching record.
- Order detail: evidence dialog opens and closes with Escape.
- Supplier message: draft is editable; confirmation is persisted locally and clearly marked simulated.
- Playbook: add, toggle, reload persistence, and delete.
- CSV: missing-column validation; valid-row preview and import; imported orders await analysis.
- Demo: all six visible steps complete, including auditor rejection and correction; two sample orders become exposed; imported data survives.
- All six views checked for page overflow at 390 px; mobile overview visually reviewed.
- Overview additionally checked at 360, 768, 1024 and 1280 px.
- Mobile navigation closes after changing page and selecting the current page.
- Order detail desktop screenshot visually reviewed.
- Zero uncaught browser errors in the exercised flows.

## Limits
No backend, live agents, current legal verification, cross-browser matrix, screen-reader audit, server persistence, authentication, or actual provider delivery is included in this frontend validation. Google Fonts has local system fallbacks; port photography is stored with the app.

## Pre-login landing update

- Production build passes with a separately lazy-loaded Three.js globe bundle. Vite reports its standard 500 kB advisory for the 528 kB minified 3D chunk (about 133 kB gzip); it is separate from the main application bundle.
- Landing checked at 360, 390, 768, 1024, 1440, and 1920 px without horizontal overflow.
- Desktop landing, mobile landing, and desktop entry screen screenshots reviewed.
- How-it-works and About dialogs, Escape dismissal, and focus restoration passed.
- Login entry → demo workspace → orders → impact → public home navigation passed.
- Photo pointer tilt verified; globe keyboard and pointer rotation verified by rendered output changes.
- Reduced-motion disables the photo tilt and automatic globe movement. Mobile login has no horizontal overflow.
- No uncaught browser errors in the landing/navigation test flow.

## Full site and account-flow revision

Verified in headless Chrome with a production build:
- Header links scroll to How/About/Contact sections; no landing dialogs remain. The last section aligns as far as the page bottom permits.
- Inquiry draft saves locally, survives reload, and can be cleared; the UI states that it is not sent.
- Signup validation and password visibility; verification preview; all three onboarding steps; workspace arrival.
- Account edits persist after reload and update the workspace identity.
- Logout clears the demo session; direct workspace access routes to login and restores the intended order page after demo sign-in.
- Password-reset mismatch error and successful preview completion.
- Password test values are absent from local/session storage.
- Landing, login, signup, onboarding, account, privacy, and 404 checked for overflow at 360, 390, 768, 1024, and 1440 px.
- Desktop and mobile screenshots reviewed for all three public sections; account settings and mobile sign-in reviewed.
- Reduced-motion stops parallax transforms.
- No uncaught browser errors in the exercised flows.

These checks cover frontend behavior only. Authentication, email verification, password reset, contact delivery, and notification delivery remain backend integrations.

## Trade map

Verified on 12 October 2026 against a production build in headless Chrome (Playwright driving the installed Chrome):
- World, Production · Vietnam, Europe, North America and Asia-Pacific views render country outlines, markers and routes; nearby ports merge (Los Angeles · Long Beach) and overlapping markers are nudged apart.
- Market panel: EU lists its orders, flags Binh Phu Wood's missing plot-level geolocation for PO-2291 and PO-2304 (matching the sample scenario), and lists per-shipment documents.
- Supplier and site panels, including deep link `map/supplier/Binh Phu Wood`.
- Satellite layer: selecting a sample flood zooms to its extent, lists suppliers and sites within 25 km, drafts an editable check-in message (copy only, nothing sent) and marks the supplier's orders "Unconfirmed" without changing their status.
- Market comparison from the order page (PO-2291, EU → US): reuse / re-evaluate / not-enough-information groups and the paperwork-only caveat; choosing the comparison market by clicking the map.
- After importing `public/samples/exportmate-sample-orders.csv` (24 rows), all eight markets appear.
- Connected session with mocked `/api/v1` responses: document records show as not connected, sample suppliers without orders are hidden, an unknown supplier and an unplaceable destination are listed under "Not on the map".
- No horizontal overflow at 360, 390, 768, 1024 and 1440 px; desktop and mobile screenshots reviewed; no uncaught browser errors.

Supplier sites, document records, market checklists and flood observations are illustrative fixtures. No live satellite data, legal verification or message delivery is involved.

### Trade map on the backend (12 October 2026)

Supersedes the fixture-based trade map checks above where they differ. Map data moved from the frontend into Postgres (Cloud SQL in production) behind `GET /api/v1/trade-map` and `GET /api/v1/trade-map/compare`.
- Backend: `uv run pytest` 54 passed, including placement, document checks (missing / wrong standard / unknown supplier), HS scoping, company isolation (another company sees no suppliers, sites or orders; compare returns 404), comparison results and errors, idempotent reference seed, and log lines carrying the request ID without the token. Migration downgrades and upgrades cleanly.
- Local stack (Vite dev auth → FastAPI → Postgres): the map's markets, EU document gap (Binh Phu Wood geolocation, PO-2291/PO-2304), supplier documents, flood proximity and check-in draft, and EU→US / EU→Japan comparisons all render from API responses; no browser errors; no overflow at 390 and 1024 px.
- A demo (browser-only) session shows a sign-in prompt instead of the map.
- Vercel proxy test (`node --test tests/backend-proxy.test.mjs`, Node 22.6+): 3 passed.

### Account › About company (12 October 2026)

- Shows the company created at signup (name, role, based in, primary destination; connected sessions add order currency and the user's access level), from `GET /me`.
- Owner: a company change sends `PATCH /company` and survives a reload from the server; a personal-only change sends just `PATCH /me`. The "Saved" confirmation stays visible (the page no longer reloads the whole workspace after saving).
- Viewer: company fields are locked with an explanation. Demo session: changes save in the browser.
- No overflow at 390 px; no browser errors.

### About company as the assistant's company knowledge (12 October 2026)

- Backend: `uv run pytest` 68 passed (includes the parallel trade-route work). New: profile fields round-trip, optional fields clear with null, description can't be blank or cleared, website / year / team size validated, onboarding requires a description, `GET /company/knowledge` returns only the caller's company (viewer can read; no company → `onboarding_required`), demo seed fills only empty fields.
- Local stack: About company loads the profile from Postgres; edits send every company field and persist; a bad website shows the backend's message; a blank description is blocked before sending; onboarding refuses a blank description and sends it on completion; no overflow at 390 px.
- Assistant: a signed-in chat ("what does my company make, certifications, founded?") called `get_company_profile`, cited the company profile and passed all auditor checks; the audit records the company ID. An anonymous chat isn't offered the tool and behaves as before.

### Editable trade route (13 October 2026)

- Backend: `uv run pytest` 68 passed. New: onboarding stores transit stops (trimmed, in order); `PATCH /company` replaces them, `[]` makes the route direct and omitting `transit` leaves it alone; null, blank stops, more than 3 stops and stops over 100 characters are rejected. Migration `ed13d3d0241c` upgrades, downgrades and re-upgrades cleanly; `alembic check` reports no drift.
- Local stack (Playwright driving the installed Chrome, Vite dev server in dev-auth mode, throwaway account removed afterwards): onboarding step 2 starts at Vietnam → Singapore → European Union; adding a stop picks one not already used; the add button disappears at 3 stops; the review step and `POST /onboarding` carry the edited route. The sidebar (codes and sentence) and the Overview hero show the saved route. Account › About company edits send `transit` in `PATCH /company`, update the sidebar without a reload and survive a reload from the server; a save that doesn't change company fields sends no company request. A demo profile saved before transit existed keeps its places; a malformed one falls back to the default. No overflow at 390 px; no browser errors.

### AI service access limits and CI (13 October 2026)

- News sources: against a stub backend, `POST/PATCH/DELETE /api/sources` returned 401 with no token or a rejected one, 403 for a viewer or an account without a company, the backend's own message for an unverified email, and passed owners and editors through; an unreachable backend gave 503. Reads stay public. Each accepted change logs the user and company IDs.
- Chat limit: a request over the per-instance cap returned 429 before the agent ran; the limiter logic (taken from `index.js`) counts clients separately by the first `X-Forwarded-For` address, frees a slot after an hour, and falls back to 40 / 200 for missing or invalid env values. Local runs used a missing credentials file, so nothing reached Firestore or Gemini.
- Playwright (`npx playwright test`): 6 passed, 1 skipped (real backend). New: an owner adds and switches off a source, both requests carry the bearer token; a viewer and the sample demo see the sources read-only with an explanation and send nothing. Two tests were updated for the required company description, and a name-only account save no longer expects `PATCH /company`.
- CI steps run locally: `npm run build`; the proxy test on Node 24 (3 passed); backend `uv lock --check`, ruff check/format, `alembic upgrade head && alembic check` (no drift), `uv run pytest` (68 passed); `node --check` on every `ai/server` module.

### Fixes from docs/FIXES.md (13 October 2026)

- Frontend: `npm run build` passes; the main chunk is 364 kB (was 546 kB) now that the Firebase SDK and PapaParse load on demand, so only the globe chunk trips Vite's 500 kB warning. Playwright: 16 passed, 1 skipped (real backend). New `tests/demo-ui.spec.ts` covers the sidebar scrolling to Sign out at 1366×680, the mobile menu (current page, Sign out, `aria-expanded`), order cards keeping the status on screen at 390 px, a `map/market/EU` deep link surviving sign-in to the demo, heading spaces when line breaks are hidden, the supplier message signed with the profile name, CSV checks matching the backend with "…and N more", two-click rule deletion, and chat history cleared on sign-out with no chat button on sign-in pages. An API failure now shows an error toast (`role="alert"`).
- Screenshots re-taken at 390 and 1440 px for all workspace pages, landing, login, signup and chat: no horizontal overflow, no browser errors. News watch cards list three items with "Show all".
- Vercel proxy test on Node 25: 3 passed. `package.json` now requires Node 22.18+ (`.nvmrc`: 24); on Node 20 `npm test` fails at the proxy test.
- Backend: `uv run pytest` 72 passed. New tests cover the per-user upload limit (429), ISO currency codes in CSVs and onboarding, the stale-import cleanup (committed imports and their order citations stay), and the cached Firebase revocation check (one user lookup per minute, cleared by sign-out-everywhere). `alembic check`: no drift. Ruff clean.
- AI service: `npm test` 46 passed. New tests cover per-company source visibility and per-company "switch off", alert/article/index visibility, audit access, stripping `thought`, request body limits (413), the scan lock, blocked addresses (including IPv4-mapped, NAT64 and 6to4 forms) and the other-commodity filter. Against the real Firestore (read-only): anonymous `GET /api/sources` lists the 7 built-in sources marked shared, `GET /api/impacts` returns 10 alerts, `POST /api/scan` without a token returns 401, a 200 KB body returns 413. The new feed fetcher read TTJ, VnExpress (over NAT64) and the EU press corner, and refused `https://localhost` and `https://127.0.0.1`.
- Not exercised: real Firebase sign-in (error messages, the verification link opened on another device), the real-backend Playwright round trip, a scan with Gemini, and alerts already stored before this change (they keep their old fields and stay visible to everyone).

### New-visitor audit fixes (15 October 2026)

- Audit: exportmate.vercel.app walked through as a first-time visitor in Chrome (landing, demo workspace, every page, sign-up and login, the assistant). Found: the demo's figures were fixed strings (sample date 08 Oct, "19 days", "27 Oct · Rotterdam", "$2,400", "2 orders affected", PO-2291/PO-2304 in the walkthrough); imported demo orders stayed "Awaiting analysis" even when they matched the sample rule; the assistant answered "I cannot find an alert with the ID PO-2291" about an order on screen; the demo showed a previously signed-in account's name, email and company; Rule watch was the sample scenario for signed-in companies too; playbook rules had no effect; "SGD 14,800 SGD"; literal backticks in chat answers; "1 items".
- Frontend: `npm run build` passes (main chunk 382 kB). Playwright: 41 passed, 1 skipped (real backend). New: an imported EU acacia order from a supplier without geolocation is flagged and counted on the Overview, a US order isn't; the Overview's date, days to the next affected shipment, its place and the value at risk come from the orders and today's date, and the buyer view shows "SGD 14,800" once; the demo shows its own profile when an account profile is cached; a demo chat request carries the orders (needing action first, each with its sample check) and the switched-on rules, and inline code renders as code; signed in, Rule watch lists the company's requirements from `GET /trade-map` with links to the exact official text, and no sample scenario; signing out removes `em-profile` and the demo then shows Binh Duong Wood Co.
- Screenshots (Vite dev server, headless Chromium) of the landing at 390, 1024, 1280 and 1920 px: the new one-line explanation sits below the hero text without overlapping the headline, no horizontal overflow. Demo Overview, buyer view, Rule watch and the rule-change walkthrough checked in Chrome at 1380 px.
- Vercel proxy test on Node 25: 4 passed (Node 20 can't load the `.ts` module, as before).
- AI service: `npm test` 86 passed; `node --check` on every module. New tests: demo orders become map orders (`demoMapOrders`; malformed rows dropped, text trimmed, at most 200), demo playbook rules (`demoPlaybook`), the gateway's `orders` scope (offered to a demo with orders, refused without), the `company-orders` and `playbook` rules applying wherever their tools can read. New golden case `demo-order-status` (complex tier).
- Not exercised: the assistant against live Gemini (the golden set, including `demo-order-status`, needs a run on GCP after deploy), the signed-in chat reading `GET /playbook/rules` with a real token, and `npm run index` to re-index the updated help guides.

### Workspace tour (15 October 2026)

- First-visit walkthrough of the workspace: a welcome card, then a spotlight on each sidebar page (Overview to Playbook), the demo's Maker/Buyer switch, the assistant button and the ? that replays it. Skip, Back/Next, Escape and arrow keys; focus stays in the card and returns afterwards. Shown once per browser (`em-tour-done`); signed in it waits until the workspace has loaded. On phones the sidebar steps are centred cards.
- Playwright (port 5199, since 5175 was in use): 54 passed, 1 skipped. New `tests/tour.spec.ts`: the tour opens on a first visit, places the card beside the item it describes, goes back, closes with Escape, stays closed after a reload and reopens from the ? button; at 390 px every step fits the screen and the last one spotlights the ? button. Screenshots at 1366 and 390 px checked.
- Not exercised: a signed-in company workspace with a real backend.
