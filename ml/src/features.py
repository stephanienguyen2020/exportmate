"""The one feature function: a GTA measure or an article → the same row of numbers.

    uv run python src/features.py   # writes data/interim/features.parquet for every rated item

`feature_row(item)` takes the shared fields (docs/local/SEVERITY_MODEL.md, "Measures vs articles"):
measure_type, direction, countries (who imposes it), markets (whose goods it hits), level, targets,
hs_chapters, date, effective_date, in_force, title, text. GTA fills them from its columns
(prepare.py); an article from Gemini's reading of it (extract.py), as the scan will.
Never a feature: Gemini's severity (the baseline), the source (GTA or article), company exposure.
"""

import math
import re
from pathlib import Path

import pandas as pd

from measure_types import MEASURE_TYPES
from sources import all_articles

ML = Path(__file__).resolve().parent.parent
INTERIM = ML / "data/interim"

EU_MEMBERS = {
    "Austria",
    "Belgium",
    "Bulgaria",
    "Croatia",
    "Cyprus",
    "Czechia",
    "Denmark",
    "Estonia",
    "Finland",
    "France",
    "Germany",
    "Greece",
    "Hungary",
    "Ireland",
    "Italy",
    "Latvia",
    "Lithuania",
    "Luxembourg",
    "Malta",
    "Netherlands",
    "Poland",
    "Portugal",
    "Romania",
    "Slovakia",
    "Slovenia",
    "Spain",
    "Sweden",
}
ALIASES = {
    "united states of america": "US",
    "united states": "US",
    "usa": "US",
    "us": "US",
    "u.s.": "US",
    "european union": "EU",
    "eu": "EU",
    "united kingdom": "UK",
    "uk": "UK",
    "britain": "UK",
    "great britain": "UK",
    "canada": "CA",
    "japan": "JP",
    "republic of korea": "KR",
    "south korea": "KR",
    "korea": "KR",
    "australia": "AU",
    "vietnam": "VN",
    "viet nam": "VN",
    "china": "CN",
}
# Where the demo exporter sells (seed/inventory.js) and where it is.
OUR_MARKETS = {"US", "EU", "UK", "CA", "JP", "KR", "AU"}
HOME = "VN"
WOOD_CHAPTERS = {"44", "94"}
WOOD_WORDS = re.compile(
    r"\b(?:wood|wooden|timber|lumber|plywood|veneer|sawn|sawmill|hardwood|softwood|furniture|cabinet|"
    r"vanit(?:y|ie)|moulding|molding|millwork|mattress|flooring|mdf|particleboard|particle board|pellet|"
    r"forest product|log|rubberwood|birch|deforestation|eudr|"
    # Vietnamese: wood, furniture, plywood, (wood) pellets, forest products, kitchen cabinets
    r"gỗ|nội thất|ván ép|viên nén|lâm sản|tủ bếp)(?:s|es)?\b",
    re.IGNORECASE,
)
ACTION_WORDS = {
    "w_ban": r"\bban(s|ned)?\b|\bprohibit",
    "w_duty": r"\btariffs?\b|\bdut(y|ies)\b|\blevy\b|\bsurcharge",
    "w_dumping": r"dumping|countervailing|anti-subsidy|safeguard|circumvent",
    "w_quota": r"\bquotas?\b",
    "w_paperwork": r"licen[cs]|certificat|due diligence|traceab|deforestation|eudr|legality|geolocat",
    "w_opening": r"\b(cut|cuts|lift|lifts|lifted|exempt|exempts|exemption|reduc|eliminat|remov|relief|free trade)",
    "w_pending": r"investigat|review|propos|consult|draft|plan(s|ned)? to|considers?|could|may\b",
    "w_delay": r"delay|postpon|extend|deadline",
    "w_final": r"\bfinal\b|definitive|takes? effect|effective|enters? into force|imposes?|issues?",
}
IN_FORCE = ["in_force", "announced", "proposed", "removed"]


def country_code(name: str) -> str:
    key = name.strip().lower()
    if name.strip() in EU_MEMBERS:
        return "EU"
    return ALIASES.get(key, name.strip())


def days_bucket(date, effective_date) -> str:
    if pd.isna(effective_date) or pd.isna(date):
        return "unknown"
    days = (pd.Timestamp(effective_date) - pd.Timestamp(date)).days
    return "now" if days <= 0 else "soon" if days <= 90 else "later"


def feature_row(item: dict) -> dict:
    imposers = {country_code(c) for c in item["countries"]}
    hit = {country_code(c) for c in item["markets"]}
    chapters = set(item["hs_chapters"])
    words = f"{item['title']} {item['text']}"
    wood = bool(chapters & WOOD_CHAPTERS) or bool(WOOD_WORDS.search(words))
    row = {f"mt_{name}": float(item["measure_type"] == name) for name in MEASURE_TYPES}
    row |= {
        "dir_harms": float(item["direction"] == "harms"),
        "dir_opens": float(item["direction"] == "opens"),
        "level_supranational": float(item["level"] == "supranational"),
        "level_subnational": float(item["level"] == "subnational"),
        "targets_firm": float(item["targets"] == "firm-specific"),
        "targets_sector": float(item["targets"] == "sector-specific"),
        "by_our_market": float(bool(imposers & OUR_MARKETS)),
        "by_us": float("US" in imposers),
        "by_eu": float("EU" in imposers),
        "hits_home": float(HOME in hit),
        "hits_unnamed": float(not hit),
        "hits_many": math.log1p(len(hit)),
        "wood": float(wood),
        "wood_narrow": float(wood and 0 < len(chapters) <= 3),
        "chapters": math.log1p(len(chapters)),
        "horizontal": float(len(chapters) > 10),
    }
    bucket = days_bucket(item["date"], item["effective_date"])
    row |= {f"when_{name}": float(bucket == name) for name in ("now", "soon", "later", "unknown")}
    row |= {f"state_{name}": float(item["in_force"] == name) for name in IN_FORCE}
    row |= {
        name: float(bool(re.search(pattern, words, re.IGNORECASE))) for name, pattern in ACTION_WORDS.items()
    }
    return row


def shared_fields() -> pd.DataFrame:
    """Every rated item in the shared fields, GTA from its columns and articles from extract.py."""
    rated = pd.read_csv(ML / "labels/rated.csv")
    gta = pd.read_parquet(INTERIM / "gta.parquet")
    gta["text"] = ""
    articles = all_articles()
    # Headlines only: archive articles have no snippet (embed.py does the same).
    articles["text"] = ""
    fields = pd.read_parquet(INTERIM / "article_fields.parquet")
    articles = articles[["item_id", "source", "title", "text", "date"]].merge(fields, on="item_id")
    articles["group_id"] = "title:" + articles["title"].str.split(" - ").str[0].str.lower().str.slice(0, 60)
    columns = [
        "item_id",
        "source",
        "group_id",
        "title",
        "text",
        "date",
        "measure_type",
        "direction",
        "countries",
        "markets",
        "level",
        "targets",
        "hs_chapters",
        "effective_date",
        "in_force",
    ]
    items = pd.concat([gta[columns], articles[columns]])
    return items[items["item_id"].isin(set(rated["item_id"]))]


def main() -> None:
    items = shared_fields()
    rows = pd.DataFrame([feature_row(item) for item in items.to_dict("records")])
    table = pd.concat([items[["item_id", "source", "group_id", "date"]].reset_index(drop=True), rows], axis=1)
    table.to_parquet(INTERIM / "features.parquet", index=False)
    print(
        f"{len(table)} items, {rows.shape[1]} features ({(table['source'] == 'article').sum()} scan articles, {(table['source'] == 'archive').sum()} archive)"
    )


if __name__ == "__main__":
    main()
