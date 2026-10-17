"""ExportMate architecture figure, AWS-reference style: one icon per managed service, coloured by
category, grouped by provider/project, numbered request flows. Emits an SVG fragment for the
page (styled by the page's CSS tokens) or a standalone light SVG file for the repo."""

from html import escape

# Category -> tile colour (AWS convention: colour = service category).
CAT = {
    "compute": "#C8590F",
    "storage": "#2F7A1F",
    "database": "#3442B8",
    "ai": "#0B7F73",
    "security": "#B7202E",
    "ops": "#B0175A",
    "network": "#6C3BD1",
    "external": "#55615B",
}

# White glyphs inside a 44x44 tile.
GLYPH = {
    "user": '<circle cx="22" cy="17" r="5"/><path d="M12 33c1.5-6 5.5-9 10-9s8.5 3 10 9"/>',
    "browser": '<rect x="11" y="12" width="22" height="20" rx="2"/><path d="M11 17.5h22"/>'
    '<circle cx="14.5" cy="14.8" r=".9" fill="#fff" stroke="none"/><circle cx="17.5" cy="14.8" r=".9" fill="#fff" stroke="none"/>',
    "function": '<path d="M27 12c-3.5 0-4.5 2-5 5.5L20 32"/><path d="M16 21h9"/>',
    "rewrite": '<path d="M12 29h10a6 6 0 0 0 6-6v-7"/><path d="M24 19.5l4-4 4 4"/>',
    "run": '<path d="M22 10l10.4 6v12L22 34l-10.4-6V16z"/><path d="M19.5 18l5 4-5 4"/>',
    "job": '<path d="M22 10l10.4 6v12L22 34l-10.4-6V16z"/><path d="M17.5 19h9M17.5 23h9M17.5 27h5"/>',
    "sql": '<ellipse cx="22" cy="15" rx="9" ry="3.5"/><path d="M13 15v14c0 2 4 3.5 9 3.5s9-1.5 9-3.5V15"/>'
    '<path d="M13 22c0 2 4 3.5 9 3.5s9-1.5 9-3.5"/>',
    "firestore": '<rect x="16" y="11" width="15" height="18" rx="1.5"/><path d="M13 15v18h13"/><path d="M19.5 17h8M19.5 21h8M19.5 25h5"/>',
    "bucket": '<path d="M12 15h20l-2.6 17H14.6z"/><path d="M13.3 21h17.4"/>',
    "gemini": '<path d="M22 10c1 6 4 9 10 12-6 1-9 4-10 10-1-6-4-9-10-10 6-3 9-6 10-12z" fill="#fff" stroke="none"/>',
    "rag": '<circle cx="20" cy="20" r="7"/><path d="M25 25l7 7"/><path d="M17 20h6"/>',
    "agent": '<rect x="13" y="16" width="18" height="14" rx="3"/><circle cx="18.5" cy="23" r="1.5" fill="#fff" stroke="none"/>'
    '<circle cx="25.5" cy="23" r="1.5" fill="#fff" stroke="none"/><path d="M22 11.5V16"/>',
    "shield": '<path d="M22 11l9 3.5V21c0 6-4 9.5-9 11.5-5-2-9-5.5-9-11.5v-6.5z"/><path d="M18 22l3 3 5-6"/>',
    "key": '<circle cx="17" cy="22" r="4.5"/><path d="M21.5 22H32M28 22v4M31.5 22v3"/>',
    "clock": '<circle cx="22" cy="22" r="10"/><path d="M22 16v6l4 3"/>',
    "logs": '<path d="M14 15h16M14 20h16M14 25h11M14 30h13"/>',
    "metrics": '<path d="M12 32h20"/><path d="M13 28l6-7 5 4 7-10"/>',
    "monitor": '<rect x="11" y="12" width="22" height="16" rx="2"/><path d="M15 23l4-4 4 3 6-6"/><path d="M18 32.5h8"/>',
    "bell": '<path d="M15.5 28v-6.5a6.5 6.5 0 0 1 13 0V28l2 2h-17z"/><path d="M20 32.5a2 2 0 0 0 4 0"/>',
    "mail": '<rect x="11" y="14" width="22" height="16" rx="2"/><path d="M11.5 15.5l10.5 8 10.5-8"/>',
    "rss": '<circle cx="15" cy="29" r="2" fill="#fff" stroke="none"/><path d="M13 21a10 10 0 0 1 10 10"/><path d="M13 14a17 17 0 0 1 17 17"/>',
}

W, H = 1600, 1110

# id: (x, y, glyph, category, [label lines], style)  style: "" | "off" (not live) | "old"
NODES = {
    "user": (75, 490, "user", "external", ["People", "web browser"], ""),
    "resend": (240, 800, "mail", "external", ["Resend", "email API"], ""),
    "gemini": (880, 70, "gemini", "ai", ["Vertex AI Gemini", "models + embeddings"], ""),
    "feeds": (1320, 70, "rss", "external", ["News feeds", "RSS / Atom"], ""),
    "web": (265, 360, "browser", "network", ["Website", "React SPA"], ""),
    "proxy": (265, 490, "function", "compute", ["/api/v1 proxy", "function · waits 55 s"], ""),
    "rewrite": (265, 620, "rewrite", "network", ["/api/* rewrite", "to the AI service"], ""),
    "auth": (510, 260, "shield", "security", ["Firebase Auth", "sign-in · ID tokens"], ""),
    "secret": (722, 260, "key", "security", ["Secret Manager", "DB URL · Resend key"], ""),
    "backend": (510, 488, "run", "compute", ["Cloud Run", "exportmate-backend", "FastAPI"], ""),
    "seedjob": (690, 600, "job", "compute", ["Cloud Run job", "migrate · seed"], ""),
    "sql": (510, 790, "sql", "database", ["Cloud SQL", "Postgres 16 · pgvector"], ""),
    "docs": (690, 790, "bucket", "storage", ["Cloud Storage", "documents bucket"], ""),
    "sched2": (880, 380, "clock", "ops", ["Cloud Scheduler", "duplicate daily scan"], "old"),
    "ai2": (880, 560, "run", "compute", ["Cloud Run", "exportmate-ai (old)"], "old"),
    "fs2": (880, 790, "firestore", "database", ["Firestore", "old AI data"], "old"),
    "sched": (1110, 260, "clock", "ops", ["Cloud Scheduler", "daily 07:00 ICT"], ""),
    "runtime": (1470, 260, "agent", "ai", ["Agent Runtime", "Memory Bank · not live"], "off"),
    "ai": (1110, 488, "run", "compute", ["Cloud Run", "exportmate-ai", "API + ADK agents"], ""),
    "opsjob": (1290, 580, "job", "compute", ["Cloud Run job", "ops · eval · re-index"], ""),
    "fs": (1110, 790, "firestore", "database", ["Firestore", "audits · alerts · scans"], ""),
    "kb": (1290, 790, "bucket", "storage", ["Cloud Storage", "exportmate-app-kb"], ""),
    "rag": (1470, 790, "rag", "ai", ["RAG Engine", "one corpus per type"], ""),
    "logging": (200, 1010, "logs", "ops", ["Cloud Logging", "JSON lines · request IDs"], ""),
    "metrics": (520, 1010, "metrics", "ops", ["Log-based metrics", "events · answers · latency"], ""),
    "monitoring": (840, 1010, "monitor", "ops", ["Cloud Monitoring", "dashboards · uptime checks"], ""),
    "alerts": (1160, 1010, "bell", "ops", ["Alert policies", "errors · 5xx · storage · disk"], ""),
    "inbox": (1460, 1010, "mail", "external", ["Email", "owner's inbox"], ""),
}

# (x, y, w, h, title, subtitle, style)  style: "" | "lane" | "old"
GROUPS = [
    (150, 740, 180, 120, "Internet", "", ""),
    (780, 22, 200, 120, "Google · global", "", ""),
    (1240, 22, 160, 120, "Internet", "", ""),
    (150, 300, 230, 400, "Vercel", "exportmate.vercel.app", ""),
    (420, 170, 560, 730, "Google Cloud · backend", "skilful-scarab-511320-q9 · asia-southeast1", ""),
    (440, 700, 330, 180, "Data & storage", "", "lane"),
    (800, 310, 160, 570, "Old AI copy", "image c5c9196 · still running", "old"),
    (1020, 170, 560, 730, "Google Cloud · AI", "exportmate-app · asia-southeast1", ""),
    (1040, 700, 520, 180, "Data & storage", "", "lane"),
    (20, 940, 1560, 150, "Observability", "both projects", ""),
]

# (points, style, label (text, x, y, anchor), badge (n, x, y))
#   style: "" request | "bad" broken | "off" not live | "log" logs
EDGES = [
    ([(97, 490), (200, 490)], "line", None, None),
    ([(200, 360), (200, 620)], "line", None, None),
    ([(200, 360), (243, 360)], "", None, (1, 218, 346)),
    ([(200, 490), (243, 490)], "", None, (3, 218, 476)),
    ([(200, 620), (243, 620)], "", None, (4, 218, 606)),
    ([(75, 468), (75, 260), (488, 260)], "", ("sign in", 128, 252, "start"), (2, 75, 380)),
    ([(287, 490), (488, 490)], "", ("Bearer ID token", 388, 481, "middle"), None),
    ([(510, 466), (510, 322)], "", ("verify ID token", 517, 400, "start"), None),
    ([(532, 474), (645, 474), (645, 70), (858, 70)], "", ("AI steps · JSON", 712, 61, "middle"), None),
    ([(510, 568), (510, 768)], "", ("SQL · CSV uploads", 517, 640, "start"), None),
    ([(510, 742), (690, 742), (690, 768)], "", ("certificates · texts", 600, 734, "middle"), None),
    ([(690, 662), (690, 700)], "", None, None),
    ([(532, 504), (760, 504), (760, 560), (858, 560)], "bad", ("AI_SERVICE_URL", 660, 522, "middle"), (7, 572, 504)),
    ([(1088, 488), (532, 488)], "", ("company data · caller's token", 900, 480, "middle"), None),
    ([(287, 620), (400, 620), (400, 672), (1000, 672), (1000, 506), (1088, 506)], "", ("chat · News watch", 1006, 598, "start"), None),
    ([(1110, 322), (1110, 466)], "", ("POST /api/scan · OIDC", 1117, 400, "start"), (5, 1110, 350)),
    ([(1088, 474), (996, 474), (996, 70), (902, 70)], "", ("agents · scan", 990, 150, "end"), None),
    ([(1132, 474), (1200, 474), (1200, 70), (1298, 70)], "", ("read feeds", 1206, 150, "start"), None),
    ([(1110, 568), (1110, 768)], "", ("audits · alerts · scans", 1117, 662, "start"), None),
    ([(1110, 742), (1470, 742), (1470, 768)], "line", None, None),
    ([(1290, 742), (1290, 768)], "", ("RAG files · search", 1200, 734, "middle"), None),
    ([(1312, 790), (1448, 790)], "", ("import", 1380, 782, "middle"), None),
    ([(1290, 642), (1290, 700)], "", ("reads audits, scans", 1297, 676, "start"), None),
    ([(880, 442), (880, 538)], "old", None, None),
    ([(880, 622), (880, 768)], "old", None, None),
    ([(488, 502), (432, 502), (432, 800), (262, 800)], "bad", ("refused (403)", 381, 792, "middle"), (6, 432, 560)),
    ([(700, 900), (700, 940)], "log", ("logs", 707, 925, "start"), None),
    ([(1132, 492), (1470, 492), (1470, 322)], "off", ("not used: AGENTS_AT unset", 1300, 484, "middle"), None),
    ([(1300, 900), (1300, 940)], "log", ("logs", 1307, 925, "start"), None),
    ([(222, 1010), (498, 1010)], "", ("count events", 360, 1002, "middle"), None),
    ([(542, 1010), (818, 1010)], "", ("chart", 680, 1002, "middle"), None),
    ([(862, 1010), (1138, 1010)], "", ("thresholds", 1000, 1002, "middle"), None),
    ([(1182, 1010), (1438, 1010)], "", ("notify", 1310, 1002, "middle"), None),
]

FILE_CSS = """
.bg{fill:#F7F8F5}.grp{fill:#FFFFFF;stroke:#B9C3BB}.lane{fill:#EEF3EC;stroke:#B9C3BB}
.oldg{fill:#FFF6EC;stroke:#B06000}.gt{fill:#18261F}.gs{fill:#5B6A61}
.nl{fill:#18261F}.ns{fill:#5B6A61}.ln{stroke:#2B3A31;fill:none}.ln.bad{stroke:#C5221F}
.ln.off,.ln.old{stroke:#8A968E}.ln.log{stroke:#8A968E}.ah{fill:#2B3A31}.ah.bad{fill:#C5221F}.ah.old,.ah.log{fill:#8A968E}
.al{fill:#2B3A31;stroke:#FFFFFF}.al.bad{fill:#C5221F}.al.old{fill:#6B7770}.bd{fill:#18261F}.bdt{fill:#FFFFFF}
.bd.bad{fill:#C5221F}.ring{stroke:#8A968E}.ring.old{stroke:#B06000}
text{font-family:"IBM Plex Sans",Helvetica,Arial,sans-serif}
"""


def _tile(prefix: str, glyph: str, cat: str) -> str:
    return (
        f'<symbol id="{prefix}{glyph}-{cat}" viewBox="0 0 44 44">'
        f'<rect width="44" height="44" rx="9" fill="{CAT[cat]}"/>'
        f'<g fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{GLYPH[glyph]}</g>'
        "</symbol>"
    )


def symbols(prefix: str, pairs) -> str:
    return "".join(_tile(prefix, g, c) for g, c in sorted(set(pairs)))


def svg(mode: str = "page") -> str:
    p = "f-" if mode == "page" else "x-"
    out = []
    aria = (
        "ExportMate architecture: browsers reach the Vercel website, which proxies /api/v1 to the "
        "backend on Cloud Run in project skilful-scarab and rewrites /api to the AI service on Cloud "
        "Run in project exportmate-app. The backend stores data in Cloud SQL and a Cloud Storage "
        "documents bucket; the AI service stores data in Firestore, a Cloud Storage bucket and RAG "
        "Engine. Both call Vertex AI Gemini and log to Cloud Logging, which feeds metrics, "
        "dashboards and email alerts. Two edges are broken: the backend reads an old AI copy, and "
        "email to Resend is refused."
    )
    attrs = f'viewBox="0 0 {W} {H}" role="img" aria-label="{escape(aria)}"'
    if mode == "file":
        attrs = f'xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" ' + attrs
    out.append(f"<svg {attrs} class=\"arch\">")
    defs = [symbols(p, [(n[2], n[3]) for n in NODES.values()])]
    for kind in ("", "bad", "old", "log"):
        cls = f"ah {kind}".strip()
        defs.append(
            f'<marker id="{p}ar{kind}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
            f'<path d="M0 0L10 5L0 10z" class="{cls}"/></marker>'
        )
    if mode == "file":
        defs.append(f"<style>{FILE_CSS}</style>")
    out.append("<defs>" + "".join(defs) + "</defs>")
    if mode == "file":
        out.append(f'<rect class="bg" width="{W}" height="{H}"/>')

    for x, y, w, h, title, sub, style in GROUPS:
        cls = {"lane": "lane", "old": "oldg"}.get(style, "grp")
        dash = ' stroke-dasharray="6 5"' if style in ("old",) else ""
        out.append(f'<rect class="{cls}" x="{x}" y="{y}" width="{w}" height="{h}" rx="10" stroke-width="1.2"{dash}/>')
        ty = y + h - 12 if style == "lane" else y + 20
        out.append(f'<text class="gt" x="{x + 12}" y="{ty}" font-size="12" font-weight="600" letter-spacing=".06em">{escape(title.upper())}</text>')
        if sub:
            out.append(f'<text class="gs" x="{x + 12}" y="{y + 35}" font-size="11">{escape(sub)}</text>')

    for pts, style, label, badge in EDGES:
        d = "M" + " L".join(f"{x} {y}" for x, y in pts)
        kind = {"off": "old"}.get(style, style if style in ("bad", "old", "log") else "")
        cls = f"ln {kind}".strip()
        dash = {"bad": ' stroke-dasharray="7 5"', "old": ' stroke-dasharray="4 4"', "off": ' stroke-dasharray="4 4"', "log": ' stroke-dasharray="2 4"'}.get(style, "")
        marker = "" if style == "line" else f' marker-end="url(#{p}ar{kind})"'
        out.append(f'<path class="{cls}" d="{d}" stroke-width="1.6"{dash}{marker}/>')

    for nid, (x, y, glyph, cat, lines, style) in NODES.items():
        if style:
            ring = "ring old" if style == "old" else "ring"
            out.append(f'<rect class="{ring}" x="{x - 26}" y="{y - 26}" width="52" height="52" rx="12" fill="none" stroke-width="1.4" stroke-dasharray="4 3"/>')
        op = ' opacity=".55"' if style == "off" else ""
        out.append(f'<use href="#{p}{glyph}-{cat}" x="{x - 22}" y="{y - 22}" width="44" height="44"{op}/>')
        for i, line in enumerate(lines):
            cls, size, weight = ("nl", 12.5, 600) if i == 0 else ("ns", 11.5, 400)
            out.append(f'<text class="{cls}" x="{x}" y="{y + 40 + i * 14}" font-size="{size}" font-weight="{weight}" text-anchor="middle">{escape(line)}</text>')

    for pts, style, label, badge in EDGES:
        if label:
            text, lx, ly, anchor = label
            cls = {"bad": "al bad", "off": "al old"}.get(style, "al")
            out.append(
                f'<text class="{cls}" x="{lx}" y="{ly}" font-size="11" text-anchor="{anchor}" '
                f'stroke-width="4" stroke-linejoin="round" paint-order="stroke">{escape(text)}</text>'
            )
        if badge:
            n, bx, by = badge
            cls = "bd bad" if style == "bad" else "bd"
            out.append(f'<circle class="{cls}" cx="{bx}" cy="{by}" r="9"/>')
            out.append(f'<text class="bdt" x="{bx}" y="{by + 4}" font-size="11" font-weight="700" text-anchor="middle">{n}</text>')
    out.append("</svg>")
    return "\n".join(out)


def sprite(prefix: str = "s-") -> str:
    """Hidden symbol sheet for icons used in the page's tables."""
    pairs = [(n[2], n[3]) for n in NODES.values()] + [("bucket", "storage"), ("key", "security")]
    return f'<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>{symbols(prefix, pairs)}</defs></svg>'


if __name__ == "__main__":
    import sys

    open(sys.argv[1], "w").write('<?xml version="1.0" encoding="UTF-8"?>\n' + svg("file") + "\n")
