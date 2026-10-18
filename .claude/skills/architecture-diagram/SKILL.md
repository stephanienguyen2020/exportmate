---
name: architecture-diagram
description: Draft or revise an architecture diagram in this repo's style (Excalidraw, generated from a Python script, flows as swimlanes, service logos, one block per unit, action labels on arrows). Use when asked to draw, draft, export or change an architecture, system, data-flow or pipeline diagram, or to add one to docs/.
---

# Architecture diagrams

Diagrams are Excalidraw files generated from a Python script in `docs/`. The template is
`docs/knowledge_graph_architecture.py` (output `docs/knowledge-graph-architecture.excalidraw`): copy it
for a new diagram, keep its `Scene` class, and replace `SERVICES`, `BOXES`, `TAGS`, `FRAMES` and `ARROWS`.
Logos live in `docs/architecture-icons/` (Google Cloud icon set as `gcp-*.svg`, Simple Icons for brands,
coloured through `BRAND_COLORS`). Mention a new diagram in `CLAUDE.md`'s Docs section.

## What to draw

- **The finished system.** Draw the target as if every planned part is built. No "only if…", "later",
  "phase 2" or "not built" hedges on the drawing; what is built today goes in the related README.
- **One concern per diagram.** Leave out what belongs to another diagram (e.g. a model's training
  pipeline) and offer to draw it separately.
- **Organise by flow, not by service.** Each flow is a numbered swimlane, titled
  `"N. Name: what it does"` or `"N. Name (offline path)"`. People and website pages sit on the left;
  data stores on the right.

## Blocks

A block is one **unit**: a person (`User`, `Admin`), an AI agent, a script, a deployment unit (a Cloud
Run service, API or job), a page, a table or a store. Never a function or a step inside a unit:
merge it into its unit and put the step on an arrow (e.g. "Keep what it names" became the arrow label
"save alerts with cleaned mentions"; "Verdicts" became an endpoint of "News matches API").

- Short names: `News scan`, `News matches API`, `Publish chain version job`, `Link weights job (nightly)`,
  `Auditor script`, `Writer`, `Reviewer`, `Graph specialist`, `Orchestrator agent`. No second line
  describing what it does unless it names a scope, e.g. `Chain view + review (admin only)`.
- No file names (`scan.js`), no API paths (`/api/chat`), no auth details (`Firebase token`).
- Services are **logos with a short caption**, not boxes (Scheduler, Gemini, Firestore, Cloud Storage,
  Pub/Sub, RAG Engine, Agent Gateway, Model Armor).
- **Every block that runs on or is built with a service carries that service's logo on its top-right
  corner** (`TAGS`, 32px, overlapping the corner: `x + w - 18, y - 8`): Cloud Run for backend APIs,
  jobs and scripts, Google ADK for agents (and checks that run as ADK plugins), Gemini for steps that
  call Gemini directly. Pages, people, tables and graph nodes get none. No separate "services used"
  panel. **The logo replaces the service's name in the text**: write `Critic agent`, `Read certificate`,
  `Writer`, never `Critic agent (Gemini)` or `News scan (Cloud Run)`. A logo pokes out past the corner, so keep arrow labels next to a block's right edge below it
  (route the arrow lower on the block).
- **Postgres: one block per table**, inside a frame titled `Cloud SQL, Postgres`, with an arrow from
  each module to each table it uses. Tables that belong together (shared, versioned together) get a
  sub-frame, e.g. `Material chain`.
- **A graph database** is a frame holding its node types (ellipses) and relationships, each naming the
  table it is copied from in parentheses: `Material (graph_nodes table)`,
  `BUYS {country, form} (supplier_sourcing table)`.
- Text in a store's caption says what it holds: `Alerts (Firestore)` / `affected goods, mentions`.

## Arrows

- **The label is an action or behaviour**, a verb phrase: `upload certificate docs`,
  `suggest material and origin`, `read alerts and mentions`, `save verdict and path`,
  `check every claim cites a path`, `return answer + cited paths`, `upsert nodes + relationships`.
  Not a noun (`verdicts`, `changes`, `certificate`).
- **The arrow starts at whoever acts.** A reader points at the store (`News matches API → Alerts:
  read alerts and mentions`), even though data flows back.
- **No label when it adds nothing**: a scheduler triggering a job, hops through a gateway, a change
  feed into Pub/Sub, an agent handing over to the next one.
- **Mechanism in brackets** when it matters: `check citations and paths (after-model plugin)`.
- Draw who calls whom truthfully: if a coordinator calls two checks in turn, both arrows start at the
  coordinator (not one check calling the other). Ask when unsure how the code really runs.
- Long labels wrap onto two lines with `\n`; keep the same words.

## Style

- Colours by role, no legend: **blue** website pages and the website frame, **green** AI agents and
  Gemini steps, **yellow** backend code (APIs, jobs, scripts), **purple** data and the graph (tables,
  node types, database frames). People are plain ellipses. No outer frame around the data stores.
- **Commas, not middle dots (·) or slashes**, in every label and title: `materials, HS, origins, markets`.
- Title: a short name, e.g. `Knowledge graph and GraphRAG architecture by flow`.
- Missing logo: download the official one yourself (Google Cloud icon set, Simple Icons, or the
  product's own repository, e.g. Google ADK's `agent-development-kit.png` from `google/adk-docs`) into
  a fresh temp folder, check it is a real image, then copy it into `docs/architecture-icons/`. Both
  `.svg` and `.png` work.
- Keep it compact: move blocks left and shrink lanes and frames when there is empty space on the right.

## Working with the user

- The user edits wording by hand. **Read the current script before every edit** and change only the
  lines asked about; never revert their words.
- Regenerating rebuilds the `.excalidraw` from the script and **wipes edits made in Excalidraw**. If
  the user may have edited the `.excalidraw`, ask first and carry those edits into the script.
- When they ask what a block or arrow means, answer in plain English with an example first; suggest a
  change only after, and apply it only when they agree. Prefer one recommendation over a list.
- Questions about a store usually mean "which table or collection, read through what": answer with
  the concrete names.

## Editing and checking

- Edit the script with the Edit tool. **Do not write labels containing `\n` through a shell heredoc or
  `re.sub` replacement**: it becomes a real line break and the script stops parsing. For bulk moves
  (shifting everything right of a line), a Python script that shifts `x` values is fine; set strings
  with `\n` afterwards with Edit.
- Every arrow has an explicit `route` of absolute points (start … end) so lines don't tangle; the label
  sits on the longest segment, so give that segment room (about 7px per character).
- Arrows may start or end at a frame by its title (`NEO4J`, `CHAIN_TABLES`).
- After regenerating, run the overlap check:

  ```sh
  python -I docs/<script>.py docs/<name>.excalidraw
  python -I .claude/skills/architecture-diagram/check_overlaps.py docs/<name>.excalidraw
  ```

  It lists blocks overlapping, arrow labels or logo captions sitting on blocks or each other, and arrow
  lines running through another arrow's label (sized for Excalidraw's wider hand-drawn font). Lines
  crossing each other or block text still need eyes, so ask the user to look at it on excalidraw.com
  (File > Open), or render a screenshot if a browser is available.
- **Look at the real render**, not only the checker: export a PNG with Excalidraw's own exporter
  (headless Chromium through the frontend's Playwright) and read the image:

  ```sh
  cd frontend && node ../.claude/skills/architecture-diagram/export_png.mjs ../docs/<name>.excalidraw ../docs/<name>.png
  ```

  The same PNG is what goes in a README (`![title](…/docs/<name>.png)`, with a link to the
  `.excalidraw` to edit it). Re-export it whenever the diagram changes.
- **Excalidraw places arrow labels itself**, at the arrow's middle: the middle point when the arrow has
  an odd number of points (often a corner), else the middle of the middle segment. The template's
  `centre_longest_segment` adds invisible 1px steps so the longest segment is the middle one; keep it
  in any copy, or labels land on bends.
- Several arrows leaving one block: give each its own exit point, order them so they don't cross, and
  put each label on a horizontal segment well clear of the other arrows' vertical lines.
- Don't commit unless asked.
