"""How reports word things: dates, counts, file names and the disclaimer every report ends
with, the same in the PDF, the email and the editor."""

import re
from datetime import date

DISCLAIMER = (
    "Checks compare the supplier documents on file with each market's checklist; they do not "
    "verify the documents themselves. News alerts are matched to stock items by an AI model. "
    "Illustrative guidance, not legal advice. Confirm with the official text and your customs "
    "broker before shipping."
)


def format_day(day: date) -> str:
    return day.strftime("%d %b %Y")


def plural(count: int, word: str, many: str | None = None) -> str:
    return f"{count} {word if count == 1 else many or word + 's'}"


def join_limited(items: list[str], limit: int = 6) -> str:
    if len(items) <= limit:
        return ", ".join(items)
    return f"{', '.join(items[:limit])} and {len(items) - limit} more"


def report_filename(title: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", title).strip("-.")[:80] or "report"
    return f"exportmate-{safe}.pdf"
