"""Build app/seed_data/hs_benchmark.json: real customs rulings to test HS code suggestions on.

The rulings are HMRC's Advance Tariff Rulings: each is a product description written by the
applicant and the commodity code HMRC ruled for it (Open Government Licence v3). The first 6
digits of the UK code are the international HS code, so a ruling tells us what a correct
suggestion is for that description.

The script reads every page of the public search (25 rulings a page, one request a second),
keeps rulings whose 6-digit code is a line of our seeded tariff (seed_data/hs_headings.json),
and picks a fixed sample by hash of the ruling reference, so rebuilding with the same rulings
gives the same set. The set is held out: never tune prompts on it, or the score stops meaning
anything.

Usage:  uv run python scripts/build_hs_benchmark.py [--size 400] [--cache DIR]
"""

import argparse
import hashlib
import html
import json
import re
import sys
import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

SEED_DIR = Path(__file__).resolve().parents[1] / "app" / "seed_data"
BASE = "https://www.tax.service.gov.uk/search-for-advance-tariff-rulings"
SEARCH_URL = BASE + "/search?page={page}"
LICENCE_URL = "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/"
PER_PAGE = 25
PAUSE_SECONDS = 1.0

_ITEM = re.compile(
    r'<li role="listitem" id="search_results-list-\d+".*?(?=<li role="listitem" id="search_results-list-|</ol>)',
    re.DOTALL,
)
_REF = re.compile(r"Ruling reference\s+(\d+)")
_TOTAL = re.compile(r"of\s+([\d,]+)\s+results")


def _field(item: str, key: str) -> str:
    match = re.search(
        rf'<dt class="govuk-summary-list__key">\s*{key}\s*</dt>\s*<dd[^>]*>(.*?)</dd>',
        item,
        re.DOTALL,
    )
    return match.group(1) if match else ""


def _text(fragment: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", fragment)).split())


def parse_page(page_html: str) -> list[dict]:
    rulings = []
    for item in _ITEM.findall(page_html):
        ref = _REF.search(item)
        code = re.sub(r"\D", "", _text(_field(item, "Commodity code")))
        description = _text(_field(item, "Description"))
        if not ref or len(code) < 6 or not description:
            continue
        rulings.append(
            {
                "ref": ref.group(1),
                "description": description,
                "commodityCode": code,
                "hsCode": f"{code[:4]}.{code[4:6]}",
                "expires": _text(_field(item, "Expiry date")),
                "url": f"{BASE}/ruling/{ref.group(1)}",
            }
        )
    return rulings


def fetch(page: int, cache: Path | None) -> str:
    cached = cache / f"page-{page:04d}.html" if cache else None
    if cached and cached.exists():
        return cached.read_text(encoding="utf-8")
    request = urllib.request.Request(
        SEARCH_URL.format(page=page), headers={"User-Agent": "ExportMate-seed/1.0"}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        body = response.read().decode("utf-8")
    if cached:
        cached.write_text(body, encoding="utf-8")
    time.sleep(PAUSE_SECONDS)
    return body


def all_rulings(cache: Path | None) -> list[dict]:
    first = fetch(1, cache)
    total = int(_TOTAL.search(first).group(1).replace(",", ""))
    pages = -(-total // PER_PAGE)
    rulings = parse_page(first)
    for page in range(2, pages + 1):
        rulings += parse_page(fetch(page, cache))
        if page % 25 == 0:
            print(f"page {page}/{pages}: {len(rulings)} rulings", file=sys.stderr)
    unique = {r["ref"]: r for r in rulings}
    print(f"{len(unique)} rulings of {total} listed", file=sys.stderr)
    return list(unique.values())


def _rank(ref: str) -> str:
    return hashlib.sha256(ref.encode()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--size", type=int, default=400)
    parser.add_argument("--cache", type=Path, help="keep downloaded pages here")
    args = parser.parse_args()
    if args.cache:
        args.cache.mkdir(parents=True, exist_ok=True)

    tariff = json.loads((SEED_DIR / "hs_headings.json").read_text(encoding="utf-8"))
    lines = {h["code"] for h in tariff["headings"]}
    rulings = all_rulings(args.cache)
    in_tariff = [r for r in rulings if r["hsCode"] in lines]
    sample = sorted(in_tariff, key=lambda r: _rank(r["ref"]))[: args.size]
    out = {
        "_about": "Held-out test set for HS code suggestions: HMRC Advance Tariff Rulings, each a "
        "product description and the code HMRC ruled (first 6 digits = HS). A fixed sample by "
        "hash of the ruling reference; built by scripts/build_hs_benchmark.py. Never tune "
        "prompts on these rulings.",
        "source": "HMRC Advance Tariff Rulings",
        "sourceUrl": BASE + "/search",
        "licence": "Open Government Licence v3.0",
        "licenceUrl": LICENCE_URL,
        "downloadedOn": datetime.now(UTC).date().isoformat(),
        "rulingsListed": len(rulings),
        "rulingsInTariff": len(in_tariff),
        "cases": sorted(sample, key=lambda r: r["ref"]),
    }
    target = SEED_DIR / "hs_benchmark.json"
    target.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(sample)} cases -> {target}", file=sys.stderr)


if __name__ == "__main__":
    main()
