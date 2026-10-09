# ExportMate pre-login landing

## Layout

Reference: the user-provided Colonial editorial page. The composition preserves its dark green outer frame, white paper inset, fine header rule, oversized light first headline line, bold second line, right-aligned supporting copy, panoramic image, and three-part footer. Product copy is adapted to ExportMate.

Routes:
- `#/`: public landing page.
- `#/login`: matching entry screen; real account authentication is not connected. Explicit demo entry only, no password collection.
- `#/workspace`: original overview dashboard.
- `#/workspace/orders`, `/rules`, `/data`, `/playbook`: original product views.
- The workspace wordmark returns to the public landing page.
- Existing legacy deep links such as `#/orders/PO-2291` still work.

## Interactions

- Staggered headline and paper entrance.
- Directional navigation underlines and arrow movement.
- Pointer-responsive perspective tilt and image parallax.
- Photo captions revealed on hover.
- A lazy-loaded Three.js globe with sphere, latitude/longitude lines, stylized land outlines and trade arc. Drag or use left/right arrow keys to rotate it.
- Native modal dialogs for How it works, About us, and Get in touch; Escape handling, native focus containment and focus restoration.
- Reduced-motion treatment for CSS and automatic globe rotation; no tilt on touch.
- Small-screen reflow retains the framed editorial layout without horizontal page scrolling.

The globe is decorative, not a geographic or live trade data product. The hero is generated artwork, not a historical documentary record.

## Artwork

Built-in image-generation tool used. Workspace asset: `/Users/stephanie/Desktop/singapore_hack/public/trade-desk.png`.

Final prompt:

> Use case: photorealistic-natural. Asset type: ultra-wide website hero editorial photograph, no text or typography. Create a nostalgic candid late-1980s/early-1990s documentary film photograph of an international shipping operations desk. Seen from slightly above and behind, a shipping coordinator in an off-white short sleeve shirt seated at a large crowded control desk, figure positioned center-right. A row of five vintage beige CRT monitors across entire frame shows teal-blue maritime navigation charts, world maps, simple cargo manifests and amber terminal markings. Foreground with beige keyboards, paper shipping manifests, rolled chart, desk telephone. Through distant windows a hint of container cranes and industrial harbor in warm daylight. Match analog archival photography: tangible 35mm grain, faded cream whites, muted deep blue and green CRT screens, warm terracotta skin tones, soft flash-lit texture, subtly imperfect vintage editorial snapshot. Tight wide crop dominated by desk and monitors, not a room with empty ceiling. Rich detail, cinematic yet entirely candid and realistic, no futuristic elements, no obvious modern computers, no added text/logos/watermarks. Landscape aspect ratio approximately 3:1, compose for full width panoramic crop.

Three.js reference: https://threejs.org/docs/

## Backend follow-up

Replace the explicit demo entry screen with the authentication flow described in `BACKEND_PLAN.md`. Public landing and authenticated workspace must remain separate. Hiding routes client-side is not an authorization boundary. Connect a genuine contact channel before replacing the prototype contact dialog with an enquiry form.

## Long-form landing revision

The original informational dialogs are removed. Header links now use `#/?section=how`, `about`, or `contact` to scroll to designed sections beneath the hero. Each combines photography, scroll-linked parallax, and CSS perspective layers. The existing Three.js globe remains in the hero footer. Reduced-motion mode disables the spatial transitions.

The hero copy is reduced to “Trade changes. Clear next steps.” The workspace introduction is “Order risks. Clear next steps.”

### Additional generated assets

Both generated with the built-in image-generation tool:
- `/Users/stephanie/Desktop/singapore_hack/public/workshop.png`
- `/Users/stephanie/Desktop/singapore_hack/public/contact-desk.png`

Workshop prompt:
> Wide editorial photograph for an ExportMate website About section. A Vietnamese small woodworking factory in the late 1990s, candid side view of a craftsperson wearing an indigo work shirt carefully measuring a large pale plywood board on a workbench, hands and wood material are the focus, face turned away. Warm sunlight through tall industrial windows, wood stacked behind, green painted industrial machinery, beautiful documentary 35mm film grain and slight fading, warm cream and forest green, terracotta details. Realistic and modest small manufacturer, quiet human skill. Landscape 4:3. No text, no logos, no watermark.

Contact prompt:
> Editorial still-life photograph for the contact section of a nostalgic modern global trade website. A vintage cream push-button corded office telephone on a deep forest-green desk beside a folded maritime chart and one manila envelope, a shaft of warm late afternoon sunlight, deep elegant shadows, simple tactile composition. Close overhead three-quarter angle. Nostalgic 1980s 35mm analog film aesthetic, subdued green and cream, subtle warm grain, photoreal. Landscape 4:3, phone occupies right half, no text, no logos, no watermark.

These are illustrative generated images, not documentation of real premises or employees.
