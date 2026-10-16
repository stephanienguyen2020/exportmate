"""Build app/seed_data/hs_headings.json from the US Harmonized Tariff Schedule (USITC).

The HTS is public and its first 6 digits are the international HS code. We keep the 4-digit
headings and 6-digit subheadings of every HS chapter, so HS code suggestions work whatever a
company makes, each with its full description path, e.g. "Coffee, whether or not roasted…:
Coffee, roasted: Not decaffeinated".

Run it when the HS edition changes (HS 2027 takes effect on 1 January 2027), then commit the
JSON; the reference seed loads it and embeds new or changed lines.

Usage:  uv run python scripts/build_hs_headings.py
"""

import json
import re
import sys
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

SEED_DIR = Path(__file__).resolve().parents[1] / "app" / "seed_data"
HTS_URL = "https://hts.usitc.gov/reststop/exportList?from={ch}01&to={ch}99&format=JSON&styles=false"
SOURCE_URL = "https://hts.usitc.gov/"


def _digits(text: str) -> str:
    return re.sub(r"\D", "", text or "")


def _clean(description: str) -> str:
    text = re.sub(r"<[^>]+>", "", description or "")
    return " ".join(text.split()).rstrip(":").strip()


def hs_chapters() -> list[str]:
    """The HS chapters, 01 to 97; 77 is reserved. (98 and 99 are US-only provisions.)"""
    return [f"{n:02d}" for n in range(1, 98) if n != 77]


def headings_of_chapter(chapter: str) -> list[dict]:
    request = urllib.request.Request(
        HTS_URL.format(ch=chapter), headers={"User-Agent": "ExportMate-seed/1.0"}
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        rows = json.loads(response.read())
    path: list[str] = []  # descriptions of the open lines, by indent
    found: dict[str, dict] = {}
    for row in rows:
        indent = int(row.get("indent") or 0)
        description = _clean(row.get("description", ""))
        del path[indent:]
        path.append(description)
        digits = _digits(row.get("htsno", ""))
        code = digits[:6] if len(digits) >= 6 else digits if len(digits) == 4 else ""
        if code and code not in found and description:
            found[code] = {
                "code": f"{code[:4]}.{code[4:]}" if len(code) == 6 else code,
                "description": ": ".join(part for part in path if part),
            }
    return list(found.values())


def main() -> None:
    headings = []
    for chapter in hs_chapters():
        chapter_headings = headings_of_chapter(chapter)
        print(f"chapter {chapter}: {len(chapter_headings)} lines", file=sys.stderr)
        headings += chapter_headings
    out = {
        "_about": "4-digit headings and 6-digit subheadings of the US Harmonized Tariff Schedule "
        "(first 6 digits = the international HS code), for every HS chapter. "
        "Built by scripts/build_hs_headings.py; the description is the line's full path.",
        "source": "USITC Harmonized Tariff Schedule",
        "sourceUrl": SOURCE_URL,
        "downloadedOn": datetime.now(UTC).date().isoformat(),
        "headings": headings,
    }
    target = SEED_DIR / "hs_headings.json"
    target.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(headings)} lines -> {target}", file=sys.stderr)


if __name__ == "__main__":
    main()
