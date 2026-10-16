"""Build app/knowledge_graph/data/eudr_products.json from Annex I of the EU Deforestation Regulation.

Annex I lists, for each relevant commodity (cattle, cocoa, coffee, oil palm, rubber, soya,
wood), the Combined Nomenclature codes of the products made from it. Its first 6 digits are
the international HS code. These are the knowledge graph's official "commodity → product"
links; `material_chain.json` adds the steps in between by hand.

Reads the consolidated text named in regulation_sources.json (the EUDR document), so the
links cite the same version the checklists do. Run it when that version changes, then
commit the JSON.

Usage:  uv run python -m app.knowledge_graph.build_eudr_products
"""

import html
import json
import re
import sys
import urllib.request
from datetime import UTC, datetime

from app.knowledge_graph import GRAPH_DATA_DIR
from app.seed_data import load_seed_file

EUDR_OFFICIAL_ID = "32023R1115"
# "ex 9403 30", "1801", "ex 47": a code is 2, 4, 6 or 8 digits written in groups of 2 or 4.
CODE_PATTERN = re.compile(r"(ex\s+)?(\d{2,4}(?:\s\d{2}){0,2})(?=\s|,|$)")
APPLIES_FROM_PATTERN = re.compile(r"shall apply from\s*(\d{1,2} \w+ \d{4})")


def eudr_document() -> dict:
    sources = load_seed_file("regulation_sources.json")
    regulation = next(r for r in sources["regulations"] if r["officialId"] == EUDR_OFFICIAL_ID)
    return regulation["documents"][-1]  # newest version


def download_text(document: dict) -> str:
    request = urllib.request.Request(
        document["download"],
        headers={
            "User-Agent": "ExportMate-seed/1.0",
            "Accept": document.get("accept", "*/*"),
            "Accept-Language": "en",
        },
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read().decode("utf-8")


def _plain_text(fragment: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", fragment)).split())


def annex_i_table(page: str) -> str:
    start = page.index("ANNEX I")
    table_start = page.index("<table", start)
    return page[table_start : page.index("</table>", table_start)]


def product_lines(cell: str) -> list[str]:
    """The cell's lines, without footnote links and amendment markers (►M3 … ◄)."""
    cell = re.sub(r'<a href="#E[^"]*"[^>]*>.*?</a>', "", cell, flags=re.DOTALL)
    cell = re.sub(r"<span>\s*<a [^>]*>\s*<span[^>]*>►M\d+</span>\s*</a>\s*</span>", " ", cell)
    cell = cell.replace("◄", " ")
    return [line for line in (_plain_text(part) for part in re.split(r"<br\s*/?>", cell)) if line]


def _hs_code(cn_code: str) -> str:
    digits = cn_code.replace(" ", "")[:6]
    return f"{digits[:4]}.{digits[4:]}" if len(digits) == 6 else digits


def parse_product_line(line: str) -> list[dict]:
    """'ex 9403 30 , ex 9403 40 and ex 9403 91 Wooden furniture…' → one product per code."""
    codes = []
    rest = line
    while True:
        match = CODE_PATTERN.match(rest)
        if not match:
            break
        codes.append((bool(match.group(1)), match.group(2)))
        rest = re.sub(r"^\s*(,|and)?\s*", "", rest[match.end() :])
    if not codes:
        return []
    return [
        {
            "cnCode": cn_code,
            "hsCode": _hs_code(cn_code),
            # "ex": only the goods of this code that are made from the commodity.
            "partOfCode": partial,
            "description": rest.strip(" ;’'"),
        }
        for partial, cn_code in codes
    ]


def parse_annex_i(page: str) -> list[dict]:
    commodities = []
    for row in re.findall(r"<tr>(.*?)</tr>", annex_i_table(page), re.DOTALL)[1:]:
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.DOTALL)
        if len(cells) != 2:
            continue
        name = _plain_text(re.sub(r'<a href="#E[^"]*"[^>]*>.*?</a>', "", cells[0], flags=re.DOTALL))
        products: list[dict] = []
        for line in product_lines(cells[1]):
            parsed = parse_product_line(line)
            if parsed:
                products += parsed
            elif products and (applies := APPLIES_FROM_PATTERN.search(line)):
                applies_from = datetime.strptime(applies.group(1), "%d %B %Y").date()
                for product in products[-1:]:
                    product["appliesFrom"] = applies_from.isoformat()
            elif products:
                products[-1].setdefault("notes", []).append(line.strip("() "))
        commodities.append({"commodity": name, "products": products})
    return commodities


def main() -> None:
    document = eudr_document()
    commodities = parse_annex_i(download_text(document))
    out = {
        "_about": "Annex I of the EU Deforestation Regulation: for each relevant commodity, the "
        "Combined Nomenclature codes of the products made from it (hsCode = first 6 digits). "
        "partOfCode: the Annex says 'ex', so only the goods of that code made from the "
        "commodity. Built by app/knowledge_graph/build_eudr_products.py from the document below.",
        "regulationOfficialId": EUDR_OFFICIAL_ID,
        "documentKey": document["key"],
        "sourceUrl": document["sourceUrl"],
        "downloadedOn": datetime.now(UTC).date().isoformat(),
        "commodities": commodities,
    }
    target = GRAPH_DATA_DIR / "eudr_products.json"
    target.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    for commodity in commodities:
        print(f"{commodity['commodity']}: {len(commodity['products'])} codes", file=sys.stderr)
    print(f"-> {target}", file=sys.stderr)


if __name__ == "__main__":
    main()
