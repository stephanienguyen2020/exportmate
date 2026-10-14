"""Reports a person previews, edits and sends as a PDF.

Two kinds, generated from the same data as the trade map (services/trade_map.py):
- order: one order, its market's document checklist with the official text behind each line,
  and the CSV row it came from.
- company: what is happening (checklist changes, new regulation versions, floods near suppliers
  and sites, news alerts) and what it affects (orders with document gaps, suppliers).

Generating stores a draft with the report twice: `original` and an editable `content`. Every
part of `content` can be edited, but the PDF shades each line that differs from `original`,
and says what was changed, added or removed and by whom. Sending locks the draft.

Neither is the phase 2 exposure report (docs/REQUIREMENTS.md §4.6), which prices exposures.
"""

import html
import logging
import re
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path

from fpdf import FPDF, FontFace
from sqlalchemy.orm import Session

from app.core.context import CompanyContext
from app.core.email import EmailAttachment, OutgoingEmail, get_email_sender
from app.core.errors import AppError, not_found_error
from app.core.news_alerts import fetch_news_alerts
from app.database.models import ReportDraft, ReportKind
from app.database.queries import audit as audit_queries
from app.database.queries import orders as order_queries
from app.database.queries import regulations as regulation_queries
from app.database.queries import reports as report_queries
from app.database.queries import trade_map as map_queries
from app.schemas.orders import OrderOut
from app.schemas.reports import (
    ReportContent,
    ReportCreateIn,
    ReportDraftOut,
    ReportDraftSummaryOut,
    ReportEditsOut,
    ReportEmailOut,
    ReportRow,
    ReportSection,
)
from app.schemas.trade_map import MapOrderOut, RequirementSourceOut
from app.services import trade_map as trade_map_service

FONT_DIR = Path(__file__).resolve().parents[1] / "assets" / "fonts"
FONT = "NotoSans"
STATUS_LABELS = {
    "on_file": "On file",
    "missing": "Missing",
    "mismatch": "Wrong standard",
    "prepare": "Prepare per shipment",
    "check": "Check",
    "unknown": "No supplier record",
}
GAP_STATUSES = {"missing", "mismatch"}
TONE_COLORS = {"gap": (176, 32, 32), "warn": (150, 92, 0)}
EDITED_FILL = (255, 243, 205)
KIND_LABELS = {ReportKind.order: "ORDER COMPLIANCE REPORT", ReportKind.company: "COMPANY REPORT"}
NEWS_LIMIT = 30
DRAFT_LIST_LIMIT = 30
DISCLAIMER = (
    "Checks compare the supplier documents on file with each market's checklist; they do not "
    "verify the documents themselves. News alerts are matched to stock items by an AI model. "
    "Illustrative guidance, not legal advice. Confirm with the official text and your customs "
    "broker before shipping."
)

log = logging.getLogger(__name__)


# Formatting -------------------------------------------------------------------------------


def today_utc() -> date:
    return datetime.now(UTC).date()


def format_day(day: date) -> str:
    return day.strftime("%d %b %Y")


def format_order_value(value_minor: int, currency: str) -> str:
    # Every currency is stored in hundredths, JPY and VND too.
    return f"{value_minor / 100:,.2f} {currency}"


def format_values_by_currency(orders: list[OrderOut]) -> str:
    totals: dict[str, int] = defaultdict(int)
    for order in orders:
        totals[order.currency] += order.value_minor
    return " + ".join(format_order_value(v, c) for c, v in sorted(totals.items())) or "no value"


def join_limited(items: list[str], limit: int = 6) -> str:
    if len(items) <= limit:
        return ", ".join(items)
    return f"{', '.join(items[:limit])} and {len(items) - limit} more"


def plural(count: int, word: str, many: str | None = None) -> str:
    return f"{count} {word if count == 1 else many or word + 's'}"


_TRAILING_URL = re.compile(r"^(.*)\n(https?://\S+)\s*$", re.DOTALL)


def cell_link(text: str) -> tuple[str, str | None]:
    """'Publisher\nhttps://…' renders as 'Publisher ›' linking to the URL, so long feed URLs
    don't swell a table row. Any other text is shown as written."""
    match = _TRAILING_URL.match(text)
    if not match or not match.group(1).strip():
        return text, None
    return f"{match.group(1).strip()} ›", match.group(2)


def report_filename(title: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", title).strip("-.")[:80] or "report"
    return f"exportmate-{safe}.pdf"


class _Citations:
    """Numbers each cited document version once, in order of first use."""

    def __init__(self):
        self.sources: dict[str, RequirementSourceOut] = {}
        self.quotes: dict[str, list[str]] = defaultdict(list)

    def cite(self, source: RequirementSourceOut, line_title: str) -> str:
        key = str(source.document_id)
        self.sources.setdefault(key, source)
        quote = f"{line_title}: “{source.quote}”" if source.quote else ""
        if quote and quote not in self.quotes[key]:
            self.quotes[key].append(quote)
        return f"[{list(self.sources).index(key) + 1}]"

    def section(self) -> ReportSection:
        rows = []
        for n, (key, source) in enumerate(self.sources.items(), start=1):
            official = f" ({source.official_id})" if source.official_id else ""
            rows.append(
                ReportRow(
                    id=f"source-{key}",
                    cells=[
                        f"[{n}]",
                        f"{source.regulation_title}{official}, version {source.version_number}",
                        source.source_url or "",
                        "\n".join(self.quotes[key]),
                    ],
                )
            )
        return ReportSection(
            id="sources",
            layout="sources",
            heading="Sources",
            note="The official text each checklist line cites, with the passage it relies on.",
            empty="No checklist line is cited in this report.",
            columns=["Ref", "Document", "Link", "Quoted text"],
            widths=[1, 1, 1, 1],
            rows=rows,
        )


# Generation -------------------------------------------------------------------------------


def _check_rows(checklist: MapOrderOut, citations: _Citations) -> list[ReportRow]:
    return [
        ReportRow(
            id=f"check-{check.requirement_key}",
            cells=[
                check.title,
                STATUS_LABELS.get(check.status, check.status),
                check.note,
                citations.cite(check.source, check.title),
            ],
            tone="gap" if check.status in GAP_STATUSES else None,
        )
        for check in checklist.checks
    ]


def build_order_report_content(db: Session, ctx: CompanyContext, order_id: str) -> ReportContent:
    order = order_queries.get_order_by_external_id(db, ctx.company_id, order_id)
    if not order:
        raise not_found_error("Order")
    checklist, market = trade_map_service.build_order_checklist(db, ctx, order)
    out = checklist.order
    citations = _Citations()
    check_rows = _check_rows(checklist, citations)

    if market:
        where = market.name
        if checklist.placement.approximate:
            where += " (placed at the country centre, not a known port)"
    else:
        where = "Not in a market on the trade map; no checklist applies yet."
    gaps = [c.title for c in checklist.checks if c.status in GAP_STATUSES]
    if not market:
        summary = f"{out.id} ships to {out.destination}, which is not in a market we check yet."
    else:
        summary = (
            f"{out.id} ships to {market.name} on {format_day(out.ship_date)}. "
            f"{plural(len(checklist.checks), 'checklist line')} apply; "
            + (
                f"{plural(len(gaps), 'gap')}: {', '.join(gaps)}."
                if gaps
                else "none is missing from the supplier documents on file."
            )
        )

    source = None
    if order.source_row_id:
        source = order_queries.get_import_row(db, order.source_row_id)
    return ReportContent(
        title=f"{out.id} · {out.product}",
        subtitle=f"Order compliance report · {ctx.company.name}",
        summary=summary,
        sections=[
            ReportSection(
                id="order",
                layout="facts",
                heading="Order",
                columns=["Field", "Value"],
                widths=[32, 68],
                rows=[
                    ReportRow(id=f"order-{key}", cells=[label, value])
                    for key, label, value in [
                        ("product", "Product", out.product),
                        ("supplier", "Supplier", out.supplier),
                        ("destination", "Destination", out.destination),
                        ("market", "Market", where),
                        ("hs", "HS code", out.hs_code),
                        ("ship", "Ship date", format_day(out.ship_date)),
                        ("value", "Value", format_order_value(out.value_minor, out.currency)),
                        ("status", "Status", out.status.value.replace("_", " ")),
                    ]
                ],
            ),
            ReportSection(
                id="checklist",
                layout="table",
                heading="Document checklist",
                note="Checked against the supplier documents on file for this market, HS code "
                "and ship date.",
                empty="No checklist lines apply to this order's market, HS code and ship date.",
                columns=["Requirement", "Status", "Note", "Source"],
                widths=[38, 20, 52, 10],
                tone_column=1,
                rows=check_rows,
            ),
            citations.section(),
            ReportSection(
                id="origin",
                layout="facts",
                heading="Where this order came from",
                note=f"Import {source.import_id}, row {source.row_number}." if source else "",
                empty="No source CSV row is attached to this order.",
                columns=["Column", "Value"],
                widths=[32, 68],
                rows=[
                    ReportRow(id=f"csv-{i}", cells=[key, value])
                    for i, (key, value) in enumerate((source.raw if source else {}).items())
                ],
            ),
        ],
    )


@dataclass
class _CompanyFacts:
    """Counts for the "at a glance" section and the summary."""

    open_orders: int = 0
    gap_orders: list[OrderOut] = field(default_factory=list)
    window_orders: int = 0
    window_gap_orders: int = 0
    changes: int = 0
    change_orders: set[str] = field(default_factory=set)
    versions: int = 0
    floods: int = 0
    flood_orders: set[str] = field(default_factory=set)
    alerts: int | None = 0  # None: News watch unavailable
    high_alerts: int = 0


def _change_section(
    db: Session,
    open_orders: list[MapOrderOut],
    market_names: dict[str, str],
    today: date,
    until: date,
    citations: _Citations,
    facts: _CompanyFacts,
) -> ReportSection:
    shipped_to = {m.placement.market for m in open_orders if m.placement.market}
    changing = [
        (day, kind, req)
        for req in map_queries.list_market_requirements(db)
        if req.market_code in shipped_to
        for day, kind in ((req.effective_on, "effective"), (req.changes_on, "changes"))
        if day and today <= day <= until
    ]
    sources = trade_map_service.load_requirement_sources(db, {"": [r for _, _, r in changing]})
    rows = []
    for day, kind, req in sorted(changing, key=lambda c: (c[0], c[2].market_code, c[2].title)):
        affected = [
            m.order.id
            for m in open_orders
            if m.placement.market == req.market_code
            and trade_map_service.applies_to(req, m.order.hs_code)
            and m.order.ship_date >= day
        ]
        facts.change_orders.update(affected)
        source = sources[req.regulation_document_id].model_copy(update={"quote": req.source_quote})
        rows.append(
            ReportRow(
                id=f"change-{req.market_code}-{req.requirement_key}-{kind}",
                cells=[
                    format_day(day),
                    market_names.get(req.market_code, req.market_code),
                    req.title,
                    f"Takes effect. {req.why}"
                    if kind == "effective"
                    else req.change_note or req.why,
                    join_limited(affected) or "None of your open orders ship after this date.",
                    citations.cite(source, req.title),
                ],
                tone="warn" if affected else None,
            )
        )
    facts.changes = len(rows)
    return ReportSection(
        id="changes",
        layout="table",
        heading="Checklist changes coming up",
        note="Checklist lines in the markets you ship to that take effect or change in this "
        "window, and your open orders shipping on or after that date.",
        empty="No checklist line in your markets takes effect or changes in this window.",
        columns=["Date", "Market", "Requirement", "What changes", "Your orders", "Ref"],
        widths=[13, 13, 20, 32, 16, 6],
        tone_column=4,
        rows=rows,
    )


def _news_section(alerts: list[dict] | None, since: date, facts: _CompanyFacts) -> ReportSection:
    rows = []
    if alerts is not None:
        recent = []
        for alert in alerts:
            severity = alert.get("severity")
            when = str(alert.get("publishedAt") or alert.get("createdAt") or "")[:10]
            if severity not in ("high", "medium") or alert.get("status") == "dismissed":
                continue
            try:
                published = date.fromisoformat(when)
            except ValueError:
                continue
            if published >= since:
                recent.append((severity != "high", -published.toordinal(), published, alert))
        recent.sort(key=lambda r: r[:2])
        for _, _, published, alert in recent[:NEWS_LIMIT]:
            affected = alert.get("affected") if isinstance(alert.get("affected"), list) else []
            names = [str(a.get("name") or a.get("sku")) for a in affected if isinstance(a, dict)]
            stock = alert.get("stockValueUsd")
            stock_text = join_limited(names, 3) or "No stock item named"
            if isinstance(stock, int | float) and stock:
                stock_text += f" · USD {stock:,.0f} in stock"
            # A last line holding only a URL becomes a link in the PDF (see cell_link).
            source = "\n".join(
                str(p) for p in (alert.get("publisher") or "Source", alert.get("url")) if p
            )
            rows.append(
                ReportRow(
                    id=f"news-{str(alert.get('articleId') or alert.get('id') or len(rows))[:60]}",
                    cells=[
                        format_day(published),
                        str(alert.get("headline") or alert.get("title") or "")[:500],
                        str(alert.get("severity")).capitalize(),
                        str(alert.get("why") or alert.get("action") or "")[:1500],
                        stock_text,
                        source[:2000],
                    ],
                    tone="gap" if alert.get("severity") == "high" else "warn",
                )
            )
        facts.alerts = len(rows)
        facts.high_alerts = sum(r.tone == "gap" for r in rows)
    else:
        facts.alerts = None
    return ReportSection(
        id="news",
        layout="table",
        heading="News alerts",
        note="High and medium alerts from News watch in this window. An AI model matches each "
        "article to your stock list (sample stock in this prototype), not to orders.",
        empty="News watch could not be reached when this report was generated."
        if alerts is None
        else "No high or medium alert in this window.",
        columns=["Published", "Alert", "Severity", "Why it matters", "Stock affected", "Source"],
        widths=[12, 22, 9, 27, 15, 15],
        tone_column=2,
        rows=rows,
    )


def build_company_report_content(
    db: Session, ctx: CompanyContext, days: int, authorization: str | None
) -> ReportContent:
    today = today_utc()
    since, until = today - timedelta(days=days), today + timedelta(days=days)
    trade_map = trade_map_service.build_trade_map(db, ctx)
    market_names = {m.code: m.name for m in trade_map.markets}
    open_orders = [m for m in trade_map.orders if m.order.ship_date >= today]
    open_ids = {m.order.id for m in open_orders}
    citations = _Citations()
    facts = _CompanyFacts(open_orders=len(open_orders))

    changes = _change_section(db, open_orders, market_names, today, until, citations, facts)
    news = _news_section(fetch_news_alerts(authorization), since, facts)

    # Floods near the company's suppliers and sites.
    supplier_orders = {
        s.name: [i for i in s.order_ids if i in open_ids] for s in trade_map.suppliers
    }
    flood_rows = []
    for obs in trade_map.observations:
        if not obs.nearby or obs.observed_on < since:
            continue
        orders = sorted(
            {i for p in obs.nearby if p.type == "supplier" for i in supplier_orders.get(p.ref, [])}
        )
        facts.flood_orders.update(orders)
        flood_rows.append(
            ReportRow(
                id=f"flood-{obs.id}",
                cells=[
                    format_day(obs.observed_on),
                    obs.title + (" (sample data)" if obs.is_sample else ""),
                    ", ".join(
                        f"{p.name} ({'inside' if p.distance_km == 0 else f'{p.distance_km} km'})"
                        for p in obs.nearby
                    ),
                    f"{obs.confidence.value.capitalize()}. {obs.confidence_note}",
                    join_limited(orders) or "No open order from a nearby supplier.",
                ],
                tone="warn" if orders else None,
            )
        )
    facts.floods = len(flood_rows)

    # New regulation versions, and the open orders whose checklists cite that regulation.
    citing: dict[uuid.UUID, set[str]] = defaultdict(set)
    for m in open_orders:
        for check in m.checks:
            citing[check.source.regulation_id].add(m.order.id)
    version_rows = []
    added_since = datetime.combine(since, time.min, UTC)
    for document, regulation in regulation_queries.list_documents_added_since(
        db, ctx.company_id, added_since
    ):
        orders = sorted(citing.get(regulation.id, set()))
        official = f" ({regulation.official_id})" if regulation.official_id else ""
        version_rows.append(
            ReportRow(
                id=f"version-{document.id}",
                cells=[
                    format_day(document.created_at.date()),
                    f"{regulation.title}{official}",
                    f"Version {document.version_number}: {document.title}",
                    "Shared official text"
                    if regulation.company_id is None
                    else "Uploaded by your company",
                    join_limited(orders) or "Not cited by your open orders' checklists.",
                ],
                tone="warn" if orders else None,
            )
        )
    facts.versions = len(version_rows)

    # What is affected: orders with document gaps, and the suppliers behind them.
    gap_rows = []
    by_supplier: dict[str, dict] = {}
    for m in sorted(open_orders, key=lambda m: (m.order.ship_date, m.order.id)):
        gaps = [c for c in m.checks if c.status in GAP_STATUSES]
        unknown = any(c.status == "unknown" for c in m.checks)
        key = trade_map_service.supplier_name_key(m.order.supplier)
        entry = by_supplier.setdefault(
            key, {"name": m.order.supplier, "gaps": {}, "orders": [], "unknown": False}
        )
        if gaps or unknown:
            entry["orders"].append(m.order.id)
            entry["unknown"] |= unknown
            for c in gaps:
                entry["gaps"][c.title] = STATUS_LABELS[c.status]
        if m.order.ship_date <= until:
            facts.window_orders += 1
            facts.window_gap_orders += bool(gaps)
        if not gaps:
            continue
        facts.gap_orders.append(m.order)
        gap_rows.append(
            ReportRow(
                id=f"order-{m.order.id}",
                cells=[
                    m.order.id,
                    format_day(m.order.ship_date),
                    market_names.get(m.placement.market or "", m.order.destination),
                    format_order_value(m.order.value_minor, m.order.currency),
                    "; ".join(f"{c.title}: {STATUS_LABELS[c.status]}" for c in gaps),
                    m.order.supplier,
                    ", ".join(citations.cite(c.source, c.title) for c in gaps),
                ],
                tone="gap",
            )
        )
    supplier_rows = [
        ReportRow(
            id=f"supplier-{key}",
            cells=[
                entry["name"],
                "; ".join(f"{title}: {status}" for title, status in entry["gaps"].items())
                or "No document record on file, so supplier documents can't be checked.",
                join_limited(entry["orders"], 8),
            ],
            tone="gap" if entry["gaps"] else "warn",
        )
        for key, entry in sorted(by_supplier.items())
        if entry["orders"]
    ]

    gap_value = format_values_by_currency(facts.gap_orders)
    alerts_text = (
        "News watch unavailable"
        if facts.alerts is None
        else f"{facts.alerts} high or medium ({facts.high_alerts} high)"
    )
    glance = [
        ("open", "Open orders", f"{facts.open_orders} shipping from {format_day(today)}", None),
        (
            "gaps",
            "With document gaps",
            f"{plural(len(facts.gap_orders), 'order')} · {gap_value}",
            "gap" if facts.gap_orders else None,
        ),
        (
            "window",
            f"Shipping in the next {days} days",
            f"{plural(facts.window_orders, 'order')}, {facts.window_gap_orders} with gaps",
            "warn" if facts.window_gap_orders else None,
        ),
        (
            "changes",
            "Checklist changes ahead",
            f"{facts.changes}, affecting {plural(len(facts.change_orders), 'open order')}",
            "warn" if facts.change_orders else None,
        ),
        ("news", "News alerts", alerts_text, "warn" if facts.alerts else None),
        (
            "floods",
            "Floods near suppliers or sites",
            f"{facts.floods}, near suppliers of {plural(len(facts.flood_orders), 'open order')}",
            "warn" if facts.floods else None,
        ),
        ("versions", "New regulation versions", str(facts.versions), None),
    ]
    happening = [
        f"{plural(facts.changes, 'checklist change')} in your markets in the next {days} days"
        + (f" ({plural(len(facts.change_orders), 'order')} affected)" if facts.changes else ""),
        "News watch unavailable"
        if facts.alerts is None
        else f"{plural(facts.alerts, 'news alert')} ({facts.high_alerts} high)",
        f"{plural(facts.floods, 'flood')} observed near your suppliers or sites",
        f"{plural(facts.versions, 'new regulation version')}",
    ]
    summary = (
        f"Between {format_day(since)} and {format_day(until)}: {'; '.join(happening)}. "
        f"{len(facts.gap_orders)} of {plural(facts.open_orders, 'open order')} have document "
        f"gaps ({format_values_by_currency(facts.gap_orders)})"
        + (
            f", {facts.window_gap_orders} of them shipping in the next {days} days."
            if facts.gap_orders
            else "."
        )
    )

    return ReportContent(
        title="What's happening and what it affects",
        subtitle=f"{ctx.company.name} · {format_day(since)} to {format_day(until)}",
        summary=summary,
        sections=[
            ReportSection(
                id="glance",
                layout="facts",
                heading="At a glance",
                columns=["Item", "Count"],
                widths=[38, 62],
                tone_column=1,
                rows=[
                    ReportRow(id=f"glance-{key}", cells=[label, value], tone=tone)
                    for key, label, value, tone in glance
                ],
            ),
            changes,
            news,
            ReportSection(
                id="floods",
                layout="table",
                heading="Floods near your suppliers and sites",
                note=f"Satellite flood observations from the last {days} days within "
                f"{trade_map.check_radius_km:g} km of a supplier or site. Sample observations "
                "are not a live feed.",
                empty="No flood observed near your suppliers or sites in this window.",
                columns=["Observed", "Event", "Near you", "Confidence", "Open orders"],
                widths=[13, 25, 24, 22, 16],
                tone_column=4,
                rows=flood_rows,
            ),
            ReportSection(
                id="versions",
                layout="table",
                heading="New regulation versions",
                note=f"Texts added to the regulation library in the last {days} days. A new "
                "version changes a checklist only once its requirements are reviewed.",
                empty="No regulation version was added in this window.",
                columns=["Added", "Regulation", "Version", "Library", "Open orders citing it"],
                widths=[12, 28, 28, 14, 18],
                tone_column=4,
                rows=version_rows,
            ),
            ReportSection(
                id="orders",
                layout="table",
                heading="Orders with document gaps",
                note="Open orders whose supplier documents on file miss a checklist line or "
                "meet the wrong standard, by ship date.",
                empty="No open order has a document gap.",
                columns=["Order", "Ship date", "Market", "Value", "Gaps", "Supplier", "Ref"],
                widths=[11, 12, 13, 14, 26, 16, 8],
                tone_column=4,
                rows=gap_rows,
            ),
            ReportSection(
                id="suppliers",
                layout="table",
                heading="Suppliers to follow up",
                note="Suppliers behind the gaps above, and suppliers with no document record "
                "whose orders can't be checked.",
                empty="No supplier needs follow-up.",
                columns=["Supplier", "Documents", "Open orders"],
                widths=[22, 52, 26],
                tone_column=1,
                rows=supplier_rows,
            ),
            citations.section(),
        ],
    )


# Edits ------------------------------------------------------------------------------------


@dataclass
class SectionEdits:
    text: bool = False  # heading, note, empty text or column labels
    edited: set[str] = field(default_factory=set)
    added: set[str] = field(default_factory=set)
    removed: int = 0

    @property
    def has_edits(self) -> bool:
        return bool(self.text or self.edited or self.added or self.removed)


def validate_report_update(original: ReportContent, content: ReportContent) -> None:
    """Text and rows can change; the report's structure can't."""

    def refuse(message: str) -> AppError:
        return AppError(422, "invalid_report", message)

    if [s.id for s in content.sections] != [s.id for s in original.sections]:
        raise refuse("Sections can be edited or left out, not added, removed or reordered.")
    for before, after in zip(original.sections, content.sections, strict=True):
        if (before.layout, before.widths, before.tone_column) != (
            after.layout,
            after.widths,
            after.tone_column,
        ) or len(before.columns) != len(after.columns):
            raise refuse(f"The layout of section {before.id} can't change.")
        missing = {r.id for r in before.rows} - {r.id for r in after.rows}
        if missing:
            raise refuse(
                f"Leave lines out with included=false instead of deleting them ({before.id})."
            )


def compare_report(
    original: ReportContent, content: ReportContent
) -> tuple[ReportEditsOut, dict[str, SectionEdits]]:
    per_section: dict[str, SectionEdits] = {}
    sections_removed = 0
    for before, after in zip(original.sections, content.sections, strict=False):
        edits = SectionEdits(
            text=(before.heading, before.note, before.empty, before.columns)
            != (after.heading, after.note, after.empty, after.columns)
        )
        old_rows = {r.id: r for r in before.rows}
        for row in after.rows:
            old = old_rows.get(row.id)
            if old is None:
                if row.included:
                    edits.added.add(row.id)
            elif old.included and not row.included:
                edits.removed += 1
            elif row.included and (row.cells, row.tone) != (old.cells, old.tone):
                edits.edited.add(row.id)
        per_section[after.id] = edits
        sections_removed += before.included and not after.included
    summary = ReportEditsOut(
        header=(original.title, original.subtitle, original.summary)
        != (content.title, content.subtitle, content.summary),
        sections=sum(e.text for e in per_section.values()),
        rows_edited=sum(len(e.edited) for e in per_section.values()),
        rows_added=sum(len(e.added) for e in per_section.values()),
        rows_removed=sum(e.removed for e in per_section.values()) + sections_removed,
    )
    return summary, per_section


# PDF --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class RenderedReport:
    kind: ReportKind
    content: ReportContent
    original: ReportContent
    company_name: str
    prepared_by: str
    generated_at: datetime


class _ReportPdf(FPDF):
    def __init__(self, report: RenderedReport, edited: bool):
        super().__init__(format="A4")
        self.report = report
        self.edited = edited
        self.add_font(FONT, "", str(FONT_DIR / "NotoSans-Regular.ttf"))
        self.add_font(FONT, "B", str(FONT_DIR / "NotoSans-Bold.ttf"))
        self.set_auto_page_break(auto=True, margin=18)
        self.set_margins(16, 16, 16)
        self.set_title(report.content.title)
        self.set_author(report.company_name)
        self.set_creator("ExportMate")

    def footer(self):
        self.set_y(-12)
        self.set_font(FONT, "", 7.5)
        self.set_text_color(120)
        stamp = self.report.generated_at.strftime("%Y-%m-%d %H:%M UTC")
        left = f"ExportMate · {self.report.company_name} · generated {stamp}"
        if self.edited:
            left += f" · contains edits by {self.report.prepared_by}"
        self.cell(0, 5, left, align="L")
        self.cell(0, 5, f"Page {self.page_no()}/{{nb}}", align="R")

    def heading(self, text: str):
        if self.get_y() > self.h - 50:  # keep a heading with the start of its section
            self.add_page()
        self.ln(4)
        self.set_font(FONT, "B", 11.5)
        self.set_text_color(20)
        self.multi_cell(0, 7, text, align="L", new_x="LMARGIN", new_y="NEXT")
        self.set_draw_color(210)
        self.line(self.l_margin, self.get_y(), self.w - self.r_margin, self.get_y())
        self.ln(2)

    def paragraph(self, text: str, size: float = 9.5, color: int = 40, fill: bool = False):
        self.set_font(FONT, "", size)
        self.set_text_color(color)
        self.set_fill_color(*EDITED_FILL)
        self.multi_cell(0, size * 0.55, text, align="L", fill=fill, new_x="LMARGIN", new_y="NEXT")

    def section_rows(self, section: ReportSection, edits: SectionEdits):
        rows = [r for r in section.rows if r.included]
        if not rows:
            self.paragraph(section.empty or "Nothing to report.", size=9, color=90)
            return
        if section.layout == "sources":
            for row in rows:
                fill = row.id in edits.edited or row.id in edits.added
                ref, title, link, quotes = (row.cells + ["", "", "", ""])[:4]
                self.set_font(FONT, "B", 9)
                self.set_text_color(25)
                self.set_fill_color(*EDITED_FILL)
                self.multi_cell(
                    0,
                    5,
                    f"{ref} {title}".strip(),
                    align="L",
                    fill=fill,
                    new_x="LMARGIN",
                    new_y="NEXT",
                )
                if link:
                    self.paragraph(link, size=8, color=90, fill=fill)
                if quotes:
                    self.paragraph(quotes, size=8.5, color=60, fill=fill)
                self.ln(1.5)
            return
        facts = section.layout == "facts"
        self.set_font(FONT, "", 8.5 if not facts else 9)
        self.set_text_color(25)
        # A table's cells start from the current fill colour; only edited rows get one.
        self.set_fill_color(255)
        with self.table(
            col_widths=tuple(section.widths),
            text_align="LEFT",
            line_height=4.8 if not facts else 5.4,
            borders_layout="NONE" if facts else "ALL",
            first_row_as_headings=not facts,
            headings_style=FontFace(family=FONT, emphasis="BOLD", fill_color=(242, 242, 242)),
        ) as table:
            if not facts:
                table.row(tuple(section.columns))
            for row in rows:
                shaded = row.id in edits.edited or row.id in edits.added
                cells = list(row.cells)
                if row.id in edits.added:
                    cells[0] = f"+ {cells[0]}"
                out = table.row()
                for i, text in enumerate(cells):
                    toned = row.tone and i == section.tone_column
                    style = FontFace(
                        emphasis="BOLD" if toned else None,
                        color=TONE_COLORS[row.tone]
                        if toned
                        else (110 if facts and i == 0 else None),
                        fill_color=EDITED_FILL if shaded else None,
                    )
                    shown, link = cell_link(text)
                    out.cell(shown, style=style, link=link)

    def edit_note(self, section: ReportSection, edits: SectionEdits):
        parts = []
        if edits.edited:
            parts.append(f"{plural(len(edits.edited), 'line')} changed")
        if edits.added:
            parts.append(f"{len(edits.added)} added (+)")
        if edits.removed:
            parts.append(f"{edits.removed} left out")
        if edits.text:
            parts.append("heading or note reworded")
        self.ln(1)
        self.paragraph(
            f"Edited by {self.report.prepared_by} after the report was generated: "
            f"{', '.join(parts)}. Shaded lines differ from the generated report.",
            size=7.5,
            color=110,
        )


def render_report_pdf(report: RenderedReport) -> bytes:
    content = report.content
    summary, per_section = compare_report(report.original, content)
    pdf = _ReportPdf(report, summary.has_edits)
    pdf.add_page()

    pdf.set_font(FONT, "", 8.5)
    pdf.set_text_color(110)
    pdf.cell(0, 5, KIND_LABELS[report.kind], new_x="LMARGIN", new_y="NEXT")
    pdf.set_font(FONT, "B", 18)
    pdf.set_text_color(15)
    pdf.multi_cell(0, 9, content.title, align="L", new_x="LMARGIN", new_y="NEXT")
    byline = f"Prepared by {report.prepared_by} · {format_day(report.generated_at.date())}"
    pdf.paragraph(" · ".join(p for p in (content.subtitle, byline) if p), size=9, color=90)
    if content.summary:
        pdf.ln(3)
        pdf.paragraph(content.summary, size=10, color=30, fill=summary.header)
    if summary.header:
        pdf.paragraph(
            f"Title, subtitle or summary edited by {report.prepared_by}.", size=7.5, color=110
        )

    for section in content.sections:
        if not section.included:
            continue
        edits = per_section.get(section.id, SectionEdits())
        pdf.heading(section.heading)
        if section.note:
            pdf.paragraph(section.note, size=8.5, color=90)
            pdf.ln(1.5)
        pdf.section_rows(section, edits)
        if edits.has_edits:
            pdf.edit_note(section, edits)

    left_out = [
        s.heading
        for s, o in zip(content.sections, report.original.sections, strict=False)
        if o.included and not s.included
    ]
    pdf.ln(5)
    if left_out:
        pdf.paragraph(
            f"Left out by {report.prepared_by}: {', '.join(left_out)}.", size=7.5, color=110
        )
    pdf.paragraph(DISCLAIMER, size=7.5, color=110)
    return bytes(pdf.output())


# Drafts -----------------------------------------------------------------------------------


def _load_draft(
    db: Session, ctx: CompanyContext, draft_id: uuid.UUID, for_update: bool = False
) -> ReportDraft:
    draft = report_queries.get_user_report_draft(
        db, ctx.company_id, ctx.user.id, draft_id, for_update=for_update
    )
    if not draft:
        raise not_found_error("Report")
    return draft


def _rendered(draft: ReportDraft, ctx: CompanyContext) -> RenderedReport:
    return RenderedReport(
        kind=draft.kind,
        content=ReportContent.model_validate(draft.content),
        original=ReportContent.model_validate(draft.original),
        company_name=ctx.company.name,
        prepared_by=ctx.user.name or ctx.user.email,
        generated_at=draft.created_at,
    )


def draft_summary_out(draft: ReportDraft) -> ReportDraftSummaryOut:
    return ReportDraftSummaryOut(
        id=draft.id,
        kind=draft.kind,
        title=str(draft.content.get("title", "")),
        scope=draft.scope,
        created_at=draft.created_at,
        updated_at=draft.updated_at,
        sent_at=draft.sent_at,
        sent_to=draft.sent_to,
    )


def draft_out(draft: ReportDraft, ctx: CompanyContext) -> ReportDraftOut:
    rendered = _rendered(draft, ctx)
    edits, _ = compare_report(rendered.original, rendered.content)
    return ReportDraftOut(
        **draft_summary_out(draft).model_dump(),
        company_name=rendered.company_name,
        prepared_by=rendered.prepared_by,
        content=rendered.content,
        original=rendered.original,
        edits=edits,
    )


def _as_json(content: ReportContent) -> dict:
    return content.model_dump(mode="json", by_alias=True)


def create_report_draft(
    db: Session, ctx: CompanyContext, body: ReportCreateIn, authorization: str | None
) -> ReportDraftOut:
    if body.kind == ReportKind.order:
        assert body.order_id is not None
        content = build_order_report_content(db, ctx, body.order_id)
        scope = {"orderId": body.order_id}
    else:
        content = build_company_report_content(db, ctx, body.days, authorization)
        scope = {"days": body.days}
    draft = report_queries.add_report_draft(
        db,
        ReportDraft(
            company_id=ctx.company_id,
            created_by=ctx.user.id,
            kind=body.kind,
            scope=scope,
            original=_as_json(content),
            content=_as_json(content),
        ),
    )
    db.commit()
    db.refresh(draft)
    log.info(
        "report.created",
        extra={
            "report_id": str(draft.id),
            "kind": body.kind.value,
            "sections": len(content.sections),
            "rows": sum(len(s.rows) for s in content.sections),
        },
    )
    return draft_out(draft, ctx)


def list_report_drafts(db: Session, ctx: CompanyContext) -> list[ReportDraftSummaryOut]:
    drafts = report_queries.list_user_report_drafts(
        db, ctx.company_id, ctx.user.id, DRAFT_LIST_LIMIT
    )
    return [draft_summary_out(d) for d in drafts]


def get_report_draft(db: Session, ctx: CompanyContext, draft_id: uuid.UUID) -> ReportDraftOut:
    return draft_out(_load_draft(db, ctx, draft_id), ctx)


def update_report_draft(
    db: Session, ctx: CompanyContext, draft_id: uuid.UUID, content: ReportContent
) -> ReportDraftOut:
    draft = _load_draft(db, ctx, draft_id, for_update=True)
    if draft.sent_at:
        raise AppError(409, "report_already_sent", "This report was sent and can't be edited.")
    original = ReportContent.model_validate(draft.original)
    validate_report_update(original, content)
    draft.content = _as_json(content)
    db.commit()
    db.refresh(draft)
    edits, _ = compare_report(original, content)
    log.info(
        "report.edited",
        extra={"report_id": str(draft.id), **edits.model_dump(exclude={"header"})},
    )
    return draft_out(draft, ctx)


def render_report_draft(db: Session, ctx: CompanyContext, draft_id: uuid.UUID) -> tuple[bytes, str]:
    draft = _load_draft(db, ctx, draft_id)
    rendered = _rendered(draft, ctx)
    return render_report_pdf(rendered), report_filename(rendered.content.title)


def _email_bodies(report: RenderedReport, edited: bool, message: str | None) -> tuple[str, str]:
    shared = (
        f"{report.prepared_by} at {report.company_name} shared “{report.content.title}”. "
        "The full report is attached as a PDF."
    )
    lines = [shared]
    if report.content.summary:
        lines.append(report.content.summary[:2000])
    if edited:
        lines.append(
            f"The report contains edits by {report.prepared_by}; edited lines are shaded in "
            "the PDF."
        )
    text = "\n\n".join(
        [*([f"Message from {report.prepared_by}:\n{message}"] if message else []), *lines]
    )
    text += f"\n\n--\n{DISCLAIMER}\nSent with ExportMate."
    note = (
        '<p style="border-left:3px solid #ccc;padding-left:12px;white-space:pre-wrap">'
        f"{html.escape(message)}</p>"
        if message
        else ""
    )
    body = "".join(f"<p>{html.escape(line)}</p>" for line in lines)
    footer = (
        f'<p style="color:#777;font-size:12px">{html.escape(DISCLAIMER)}<br>'
        "Sent with ExportMate.</p>"
    )
    return f'<div style="font-family:sans-serif;font-size:14px">{note}{body}{footer}</div>', text


def email_report_draft(
    db: Session,
    ctx: CompanyContext,
    draft_id: uuid.UUID,
    *,
    recipients: list[str],
    message: str | None,
    idempotency_key: str | None,
) -> ReportEmailOut:
    # Locked until commit: a second click waits, then finds the report already sent.
    draft = _load_draft(db, ctx, draft_id, for_update=True)
    if draft.sent_at:
        raise AppError(409, "report_already_sent", "This report was already sent.")
    rendered = _rendered(draft, ctx)
    edits, _ = compare_report(rendered.original, rendered.content)
    pdf = render_report_pdf(rendered)
    html_body, text_body = _email_bodies(rendered, edits.has_edits, message)
    # Titles and company names come from user input; a subject is one line.
    subject = " ".join(f"{rendered.company_name}: {rendered.content.title}".split())
    receipt = get_email_sender().send_email(
        OutgoingEmail(
            to=recipients,
            subject=subject[:200],
            html=html_body,
            text=text_body,
            reply_to=ctx.user.email or None,
            attachments=[EmailAttachment(report_filename(rendered.content.title), pdf)],
        ),
        idempotency_key=f"{ctx.user.id}:{idempotency_key}" if idempotency_key else None,
    )
    sent_at = datetime.now(UTC)
    draft.sent_at = sent_at
    draft.sent_to = recipients
    # Addresses and the note stay in the company's audit trail, never in logs.
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action="report.emailed",
        object_type="report",
        object_id=str(draft.id),
        data={
            "kind": draft.kind.value,
            "scope": draft.scope,
            "recipients": recipients,
            "message": message,
            "sandbox": receipt.sandbox,
            "messageId": receipt.message_id,
            "edits": edits.model_dump(by_alias=True),
        },
    )
    db.commit()
    log.info(
        "report.emailed",
        extra={
            "report_id": str(draft.id),
            "kind": draft.kind.value,
            "recipients": len(recipients),
            "sandbox": receipt.sandbox,
            "edited": edits.has_edits,
            "pdf_bytes": len(pdf),
        },
    )
    return ReportEmailOut(recipients=recipients, sandbox=receipt.sandbox, sent_at=sent_at)
