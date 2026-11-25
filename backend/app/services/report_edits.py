"""What a person changed in a report after it was generated: what may change (the text and
the rows, not the structure) and what did, section by section. The PDF shades and notes it;
the editor shows the summary."""

from dataclasses import dataclass, field

from app.core.errors import AppError
from app.schemas.reports import ReportContent, ReportEditsOut


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
