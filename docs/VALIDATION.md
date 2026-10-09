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
