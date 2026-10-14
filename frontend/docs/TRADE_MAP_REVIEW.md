# Trade map review — 14 October 2026

## Delivered

The world overview now uses a Three.js globe with real country outlines, elevated great-circle connections, moving route particles, orbit/zoom controls and selectable company markets. Country outlines are drawn from the bundled world-atlas data; they are not satellite imagery. Regional and flood views retain the detailed 2D map. Users can also switch the world overview to 2D.

Animation can be paused, stops on direct interaction, respects reduced-motion preferences, and skips rendering when offscreen or the document is hidden. Keyboard arrows rotate the globe; plus/minus zoom. Back-facing markers are hidden. Nearby markers are separated with leader lines. WebGL initialization/context failure falls back to 2D. Geometry, textures, controls, observers and animation callbacks are disposed on unmount.

## Implementation findings and corrections

- Market comparison previously put shipment paperwork into `reuse` solely because two markets used the same form. It now remains in `reevaluate` with `Prepare`; matching supplier records are presented as on file for review, not proven valid for this shipment.
- `dropped` previously appeared as “Not needed”. It now means “Not listed in the current checklist”; an incomplete reference checklist cannot establish that a requirement is unnecessary.
- Flood proximity previously measured distance from a centre/radius circle but described it as distance from the displayed polygon. It now estimates distance to that polygon, excludes holes, and handles longitude wraparound. The 25-km threshold is applied before rounding. Distances use a local equirectangular approximation intended for small flood extents, not survey measurements. The dashed search circle remains approximate.
- Sample observations previously produced supplier drafts that read like reports of real flooding. Drafts now explicitly retain their fictional/sample context.
- No nearby observation previously produced an unconditional “No observed flooding” message. The text now explains that this is absence of matching records, not confirmation that a site is unaffected.
- A factory panel previously asserted all company suppliers fed that particular factory without a relationship table. It now lists company suppliers with open orders.
- Scenario arcs previously stayed visible in 2D after Routes was disabled. Both projections now respect the toggle.
- Order IDs containing `|` could be split incorrectly when requesting comparisons. The request identity now uses a JSON tuple.
- Malformed URL encoding no longer crashes map initialization; cancelled map/comparison responses cannot replace the current result.
- A recorded site marked `isRouteOrigin` takes precedence. If none exists, the company profile's supported origin country supplies an approximate start, labelled as not a recorded site.
- Route comparison now draws the API's ordered origin → optional transshipment port → order destination on both globe and 2D views. These are the same coordinates used for the distance. Changing scenario or hiding routes removes that overlay. Two legs count as one proposed connection.
- Ship-date and route comparisons previously placed every unchanged requirement under “On file for review”, including missing documents and shipment forms. They now check the supplier's actual evidence; missing, mismatched and shipment-specific records remain actionable, and absent supplier records remain unknown.
- Checklist coverage warnings now count the requirements applicable to the order, rather than all industries in the destination market.

## Existing strengths

Company orders, suppliers, documents and sites are scoped by the authenticated backend context. The cross-company API tests pass. Missing supplier records are treated as unknown rather than missing evidence. Unknown destinations are surfaced instead of silently assigned invented coordinates. Requirement checks carry document-version citations. Scenario comparison is explicitly limited to paperwork, and sample observations do not change order statuses.

## Remaining limits

1. The supplied deployed sample account has 12 orders but no company sites or located supplier records. Its profile origin can supply illustrative connections, but precise site and supplier coordinates are still absent. No remote company data was changed during this task.
2. The current map has read/compare APIs. It does not yet provide a user flow for maintaining supplier coordinates or company sites.
3. Reference checklists now cover selected wood, food, textile and electronics HS prefixes, with effective/change dates and route-sensitive origin proofs. Coverage remains curated and incomplete; shipment dates do not establish arrival/import dates, and this is not a comprehensive legal engine.
4. A supplier document record has no expiry/verification/lot-coverage model. “On file” is not a compliance clearance.
5. Observations are sample records, not an automated satellite feed. The globe's moving points are illustrative trade connections, not AIS positions or vessel ETAs.
6. Company order status, checklist gaps and AI news assessments remain separate signals. The globe does not infer financial losses or change statuses from those signals.
7. The map response loads all company orders at once. A much larger dataset will need aggregation and bounds-based loading.

## Configuration and validation

Firebase/backend access and Vercel settings were verified in the preceding review. No credentials or remote company records are changed by this update. The API's new `routePoints` field requires the matching backend release; an older backend still loads the map but cannot provide the proposed route geometry.

Regression coverage includes supplier evidence classification for unchanged date/route requirements, direct and intermediate routing, unmapped destinations, both map projections, route toggle, switching scenarios and existing tenant isolation tests. See the pull request checks for the latest complete test results. The Three.js chunk-size warning remains.
