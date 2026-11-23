"""Past wood and furniture trade news → data/interim/collected.parquet (training data only).

    uv run python src/collect.py --source=google      # Google News search feeds (personal, non-commercial use)
    uv run python src/collect.py --source=fedreg      # US Federal Register notices (public domain)
    uv run python src/collect.py --source=gdelt       # GDELT archive (free, attribution "GDELT Project")
    [--start=2023-01-01] [--end=<today>]

The scan's own articles stay the test set. For each item we keep the headline, link, date and
publisher, never the page. Every source walks back quarter by quarter with the same searches, saves
after each request and skips links it already has, so a rerun (or a source that was rate-limited)
just fills in what's missing. Kept: English headlines that name our goods (features.WOOD_WORDS),
one per headline.
"""

import argparse
import email.utils
import hashlib
import itertools
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from xml.etree import ElementTree

import pandas as pd

from features import WOOD_WORDS

ML = Path(__file__).resolve().parent.parent
INTERIM = ML / "data/interim"
OUT = INTERIM / "collected.parquet"
USER_AGENT = "exportmate-ml/0.1"

# Short searches for Google News (it returns ~30 headlines per search and window).
GOOGLE_QUERIES = [
    "plywood tariff",
    "plywood anti-dumping",
    "plywood countervailing",
    "hardwood plywood duty",
    "furniture tariff",
    "furniture Section 232",
    "upholstered furniture tariff",
    "kitchen cabinets tariff",
    "cabinets vanities anti-dumping",
    "lumber tariff",
    "timber tariff",
    "softwood lumber duty",
    "timber export ban",
    "log export ban",
    "wood pellets tariff",
    "MDF anti-dumping",
    "wood flooring anti-dumping",
    "EUDR timber",
    "EUDR furniture",
    "deforestation regulation wood",
    "Vietnam wood exports tariff",
    "Vietnam furniture tariff",
    "Vietnam plywood",
    "Lacey Act timber",
    "UK Timber Regulation",
    "FLEGT timber",
    # Other markets, other goods, other angles
    "EU anti-dumping plywood",
    "EU anti-dumping wood",
    "Japan wood import rules",
    "Korea plywood anti-dumping",
    "Australia anti-dumping plywood",
    "Canada anti-dumping plywood",
    "Canada wood cabinets tariff",
    "furniture anti-dumping",
    "bedroom furniture anti-dumping",
    "wood products trade remedy",
    "wood pellets Japan",
    "wood pellets Korea",
    "EUDR delay",
    "EUDR deadline",
    "EUDR country risk",
    "EUDR guidance timber",
    "UK deforestation due diligence",
    "Section 232 timber",
    "Section 232 lumber",
    "reciprocal tariff Vietnam furniture",
    "Vietnam wood transshipment",
    "plywood customs evasion",
    "Lacey Act declaration",
    "Cameroon log export ban",
    "Gabon log export",
    "Russia birch plywood sanctions",
    "hardwood lumber tariff China",
]
# Vietnamese-language searches (Google News Vietnam edition): Vietnamese outlets follow the industry
# closely, and the embedding model reads Vietnamese.
GOOGLE_VI_QUERIES = [
    "thuế chống bán phá giá gỗ",
    "ván ép Việt Nam thuế",
    "đồ gỗ xuất khẩu thuế Mỹ",
    "EUDR gỗ",
    "gỗ xuất khẩu EU",
    "thuế đối ứng đồ gỗ",
    "Mục 232 gỗ",
    "viên nén gỗ xuất khẩu",
    "nội thất xuất khẩu thuế",
    "phòng vệ thương mại gỗ",
]
# Fewer, broader searches for GDELT (up to 250 per search and window, one request per 10 s).
GDELT_QUERIES = [
    '(plywood OR "hardwood plywood") (tariff OR duty OR "anti-dumping" OR countervailing OR investigation)',
    '(furniture OR cabinets OR vanities OR upholstered) (tariff OR "Section 232" OR "anti-dumping" OR duty)',
    '(timber OR lumber OR softwood OR hardwood) (tariff OR duty OR "Section 232" OR ban OR quota)',
    '(EUDR OR "deforestation regulation") (wood OR timber OR furniture)',
    'Vietnam (wood OR furniture OR timber) (tariff OR export OR "trade remedy" OR duty)',
    '(logs OR timber OR wood) ("export ban" OR "export tax" OR "log export")',
    '("wood pellets" OR MDF OR particleboard OR flooring OR veneer) (tariff OR "anti-dumping" OR duty OR ban)',
    '("UK Timber Regulation" OR FLEGT OR VNTLAS OR "Lacey Act" OR "illegal logging") (import OR export OR rule)',
]
# Federal Register full-text searches (trade notices by Commerce, the ITC and the President).
FEDREG_TERMS = [
    "plywood",
    "wooden cabinets",
    "vanities",
    "upholstered furniture",
    "wood furniture",
    "softwood lumber",
    "timber lumber section 232",
    "hardwood",
    "wood flooring",
    "wood mouldings",
    "mattresses",
    "furniture",
    "cabinets",
    "wood products",
    "lumber",
    "veneer",
    "particleboard",
    "wood pellets",
]
FEDREG_AGENCIES = [
    "international-trade-administration",
    "international-trade-commission",
    "executive-office-of-the-president",
]


def windows(start: str, end: str, freq: str) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    """Date windows from start to end: "MS" monthly, "QS" quarterly."""
    edges = list(pd.date_range(start, end, freq=freq)) + [pd.Timestamp(end)]
    if edges[0] > pd.Timestamp(start):
        edges.insert(0, pd.Timestamp(start))
    return [(a, b) for a, b in itertools.pairwise(edges) if a < b]


def fetch(url: str, pause: float) -> str | None:
    """GET with polite retries on rate limits and network errors; None if it keeps failing."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                body = response.read().decode("utf-8", errors="replace")
            if "limit requests" not in body[:200]:
                return body
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503):
                print(f"  HTTP {error.code}, skipped", flush=True)
                return None
        except (urllib.error.URLError, TimeoutError) as error:
            print(f"  network error: {error}", flush=True)
        time.sleep(pause * 3 * (attempt + 1))
    print("  gave up after repeated refusals", flush=True)
    return None


def google(
    query: str, start: pd.Timestamp, end: pd.Timestamp, edition: str = "hl=en-US&gl=US&ceid=US:en"
) -> list[dict] | None:
    q = f"{query} after:{start:%Y-%m-%d} before:{end:%Y-%m-%d}"
    body = fetch(f"https://news.google.com/rss/search?{urllib.parse.urlencode({'q': q})}&{edition}", 2)
    if body is None:
        return None
    items = []
    for item in ElementTree.fromstring(body).iter("item"):
        publisher = item.findtext("source") or ""
        title = item.findtext("title") or ""
        if publisher and title.endswith(f" - {publisher}"):
            title = title[: -len(publisher) - 3]
        published = (
            email.utils.parsedate_to_datetime(item.findtext("pubDate")) if item.findtext("pubDate") else None
        )
        items.append(
            {
                "id_prefix": "gnews",
                "url": item.findtext("link"),
                "title": title,
                "date": published,
                "publisher": publisher,
            }
        )
    return items


def gdelt(query: str, start: pd.Timestamp, end: pd.Timestamp) -> list[dict] | None:
    params = {
        "query": f"{query} sourcelang:english",
        "mode": "artlist",
        "maxrecords": "250",
        "format": "json",
        "startdatetime": f"{start:%Y%m%d%H%M%S}",
        "enddatetime": f"{end:%Y%m%d%H%M%S}",
    }
    body = fetch(f"https://api.gdeltproject.org/api/v2/doc/doc?{urllib.parse.urlencode(params)}", 10)
    if body is None or not body.lstrip().startswith("{"):
        return None
    return [
        {
            "id_prefix": "gdelt",
            "url": a["url"],
            "title": re.sub(r"(\w) - (\w)", r"\1-\2", a["title"]).strip(),
            "date": pd.to_datetime(a["seendate"], format="%Y%m%dT%H%M%SZ"),
            "publisher": a["domain"],
        }
        for a in json.loads(body, strict=False).get("articles", [])
    ]


def fedreg(term: str, start: pd.Timestamp, end: pd.Timestamp) -> list[dict] | None:
    params = [
        ("conditions[term]", term),
        ("per_page", "100"),
        ("order", "oldest"),
        ("conditions[publication_date][gte]", f"{start:%Y-%m-%d}"),
        ("conditions[publication_date][lte]", f"{end:%Y-%m-%d}"),
        ("fields[]", "title"),
        ("fields[]", "html_url"),
        ("fields[]", "publication_date"),
    ]
    params += [("conditions[agencies][]", agency) for agency in FEDREG_AGENCIES]
    body = fetch(f"https://www.federalregister.gov/api/v1/documents.json?{urllib.parse.urlencode(params)}", 1)
    if body is None:
        return None
    return [
        {
            "id_prefix": "fedreg",
            "url": d["html_url"],
            "title": d["title"],
            "date": pd.Timestamp(d["publication_date"]),
            "publisher": "Federal Register",
        }
        for d in json.loads(body).get("results", [])
    ]


def google_vietnam(query: str, start: pd.Timestamp, end: pd.Timestamp) -> list[dict] | None:
    return google(query, start, end, "hl=vi&gl=VN&ceid=VN:vi")


# source: (search, queries, seconds between requests, window: "MS" monthly or "QS" quarterly).
# Google returns ~30 headlines per search and window, so monthly windows find ~3 times as many.
SOURCES = {
    "google": (google, GOOGLE_QUERIES, 2, "MS"),
    "google_vi": (google_vietnam, GOOGLE_VI_QUERIES, 2, "MS"),
    "gdelt": (gdelt, GDELT_QUERIES, 10, "QS"),
    "fedreg": (fedreg, FEDREG_TERMS, 1, "QS"),
}


MAX_REFUSED_IN_A_ROW = 3


def save(items: list[dict], source: str, query: int) -> int:
    """Add new, on-topic, not-yet-seen headlines to OUT; returns how many were added."""
    done = pd.read_parquet(OUT) if OUT.exists() else pd.DataFrame(columns=["item_id", "url", "title"])
    seen = set(done["url"])
    rows = pd.DataFrame([i for i in items if i["url"] and i["url"] not in seen and i["title"]])
    if not len(rows):
        return 0
    dates = pd.to_datetime(rows["date"], utc=True, errors="coerce").dt.tz_localize(None)
    rows = pd.DataFrame(
        {
            "item_id": rows["id_prefix"]
            + ":"
            + rows["url"].map(lambda url: hashlib.sha1(url.encode()).hexdigest()[:12]),
            "source": "archive",
            "url": rows["url"],
            "title": rows["title"],
            "text": "",
            "date": dates,
            "publisher": rows["publisher"],
            "collected_from": source,
            "query": query,
        }
    )
    rows = rows[rows["title"].str.contains(WOOD_WORDS)]
    if not len(rows):
        return 0
    collected = pd.concat([done, rows]) if len(done) else rows
    key = collected["title"].str.lower().str.replace(r"[^\w ]", "", regex=True).str.slice(0, 80)
    collected = collected[~key.duplicated()]
    collected.to_parquet(OUT, index=False)
    return len(collected) - len(done)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", choices=list(SOURCES), default="google")
    parser.add_argument("--start", default="2023-01-01")
    parser.add_argument("--end", default=pd.Timestamp.today().strftime("%Y-%m-%d"))
    args = parser.parse_args()
    search, queries, pause, freq = SOURCES[args.source]
    INTERIM.mkdir(parents=True, exist_ok=True)
    refused_in_a_row = 0
    for number, query in enumerate(queries, 1):
        for start, end in windows(args.start, args.end, freq):
            items = search(query, start, end)
            refused_in_a_row = refused_in_a_row + 1 if items is None else 0
            added = save(items or [], args.source, number)
            status = "refused" if items is None else f"{len(items)} found, {added} new kept"
            print(f"{args.source} {number}/{len(queries)} {start:%Y-%m}: {status}", flush=True)
            if refused_in_a_row >= MAX_REFUSED_IN_A_ROW:
                print(
                    f"{args.source} keeps refusing; stopped. Rerun later: it skips what it has.", flush=True
                )
                return
            time.sleep(pause)
    collected = pd.read_parquet(OUT)
    print(f"{len(collected)} headlines kept in all:")
    print(collected["collected_from"].value_counts().to_string())


if __name__ == "__main__":
    main()
