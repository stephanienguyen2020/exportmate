# ExportMate — frontend plan

## Product and design
Build a working manufacturer-facing prototype from the supplied PRD v0.1 and architecture. Start with the wood corridor Vietnam → Singapore → EU. Translate the visual reference into a functional product: forest green, warm paper, large editorial headlines, monospaced labels, fine rules, generous spacing, and documentary port photography. Lime highlights identify primary actions; restrained red and amber convey exposure.

## Pages
1. **Overview** `/`: trade snapshot, open orders, money at risk, deadline, prioritized actions, watched corridor, and recent changes. Entry point to a guided rule-change demo.
2. **Orders** `/orders`: searchable and filterable open orders; select a row to review material, destination, supplier, exposure and evidence.
3. **Impact detail** `/orders/:id`: cost breakdown, deadline, recommendation, source and internal-row evidence, five-agent reasoning trace, editable supplier-message draft. Manual confirmation only; frontend simulates delivery explicitly.
4. **Rule Watch** `/rules`: relevant source coverage and a before/after sample obligation. Run a simulated change through Relevance → Exposure → Cost → Plan → Auditor, including a rejected unsupported recommendation and corrected output.
5. **Data Room** `/data`: real CSV parsing, required-field and duplicate checks, preview and explicit import; downloadable starter template. Excel/photo/PDF processing described as future backend work, not simulated extraction.
6. **Playbook** `/playbook`: add, enable/disable, and remove plain-language rules; browser-local persistence. Includes threshold, policy, supplier and watchlist examples.

## Functional boundaries
- React + TypeScript + Vite, responsive desktop/tablet/mobile.
- Hash navigation supports refresh and direct links on a static host.
- Seed 12 fictional orders; initial scenario already illustrates 2 at-risk orders. “Run demo” first resets the 12 seed orders to clear (preserving imported orders) then progressively applies the sample obligation.
- Persistent rules, imported orders, and simulated action confirmations stored locally with guarded parsing.
- Maker/buyer switch changes the perspective and clearly labels currencies; buyer impact is a separate fictional estimate.
- No credentials, live legal interpretation, real external messages, or genuine agent calls in the frontend.
- Dates and dollar estimates are fixed fictional scenario values, visibly labeled. A legal clause is an illustrative excerpt, not a verified current regulation.

## Accessibility and validation
Semantic landmarks and tables, button labels, keyboard focus, responsive navigation, dialog focus management and Escape handling, reduced-motion support. Check production build plus browser navigation, filters, demo state transitions, CSV import, playbook edits, message confirmation, and mobile overflow.

## Delivery
Working local frontend, this page plan, README with startup commands, and a backend plan with Google Cloud services, API contracts, entity design, citation validation, tenant isolation, and phased implementation checklist.

## Pre-login landing update

Added a public framed editorial landing at `#/` and a matching demo entry screen at `#/login`. The original dashboard now lives at `#/workspace`; its child routes use the same prefix. See `LANDING_DESIGN.md` for the reference layout, micro-interactions, 3D globe, and generated artwork provenance. No backend authentication is implied.

## Full site revision

Landing navigation now leads to full parallax sections, not dialogs. Added dedicated photography, spatial document/postcard/label treatments, concise copy, and an inline local inquiry draft. Complete account lifecycle screens and route behavior are specified in `ACCOUNT_AND_SITE_PLAN.md` and implemented in the frontend. Account service integration remains part of `backend/docs/BACKEND_PLAN.md`.
