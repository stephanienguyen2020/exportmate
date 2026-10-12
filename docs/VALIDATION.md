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
