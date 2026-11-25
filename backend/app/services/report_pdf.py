"""A report as an A4 PDF: the generated content, with every edit shaded and noted
(report_edits.py). Fonts are bundled so any script prints."""

import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from fpdf import FPDF, FontFace

from app.database.models import ReportKind
from app.schemas.reports import ReportContent, ReportSection
from app.services.report_edits import SectionEdits, compare_report
from app.services.report_text import DISCLAIMER, format_day, plural

FONT_DIR = Path(__file__).resolve().parents[1] / "assets" / "fonts"


FONT = "NotoSans"


TONE_COLORS = {"gap": (176, 32, 32), "warn": (150, 92, 0)}


EDITED_FILL = (255, 243, 205)


KIND_LABELS = {ReportKind.order: "ORDER COMPLIANCE REPORT", ReportKind.company: "COMPANY REPORT"}


_TRAILING_URL = re.compile(r"^(.*)\n(https?://\S+)\s*$", re.DOTALL)


def cell_link(text: str) -> tuple[str, str | None]:
    """'Publisher\nhttps://…' renders as 'Publisher ›' linking to the URL, so long feed URLs
    don't swell a table row. Any other text is shown as written."""
    match = _TRAILING_URL.match(text)
    if not match or not match.group(1).strip():
        return text, None
    return f"{match.group(1).strip()} ›", match.group(2)


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
