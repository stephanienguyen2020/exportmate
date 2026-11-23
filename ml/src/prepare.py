"""Raw data → data/interim/*.parquet, one row per GTA measure and one per news article.

    uv run python src/prepare.py            # both
    uv run python src/prepare.py --only=gta # or articles

GTA: the CSV export in data/raw/gta/ (fields up to 1 MB; only HS chapters are kept).
Articles: Firestore `articles` and `impacts` of PROJECT_ID (read-only; needs
`gcloud auth application-default login`). Gemini's severity is kept per article as the baseline
to beat, never as a label: from the sample stock's alert (no companyId) when there is one, else the
highest any company's alert got.
"""

import argparse
import csv
import os
from pathlib import Path

import pandas as pd
from google.cloud import firestore

from measure_types import gta_measure_type

ML = Path(__file__).resolve().parent.parent
GTA_CSV = ML / "data/raw/gta/gta_interventions_wood_2020-2026.csv"
INTERIM = ML / "data/interim"
PROJECT_ID = os.environ.get("PROJECT_ID", "skilful-scarab-511320-q9")
SEVERITY_RANK = {"low": 0, "medium": 1, "high": 2}


def hs_chapters(products: str) -> list[str]:
    """GTA lists 6-digit HS codes as numbers (leading zero dropped): keep their 2-digit chapters."""
    codes = [code.strip() for code in products.split(",") if code.strip().isdigit()]
    return sorted({code.zfill(6)[:2] for code in codes})


def split_list(text: str) -> list[str]:
    return [part.strip() for part in text.split(",") if part.strip()]


def prepare_gta() -> pd.DataFrame:
    csv.field_size_limit(2**31 - 1)
    with GTA_CSV.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    records = []
    for row in rows:
        announced = pd.to_datetime(row["Date Announced"] or None)
        implemented = pd.to_datetime(row["Date Implemented"] or None)
        removed = pd.to_datetime(row["Date Removed"] or None)
        records.append(
            {
                "item_id": f"gta:{row['Intervention ID']}",
                "source": "gta",
                "source_id": row["Intervention ID"],
                "group_id": f"act:{row['State Act ID']}",
                "url": row["Intervention URL"],
                "title": row["State Act Title"],
                "text": row["State Act Title"],
                "date": announced,
                "measure_type": gta_measure_type(row["Intervention Type"], row["Mast Chapter"]),
                "gta_intervention_type": row["Intervention Type"],
                "gta_evaluation": row["GTA Evaluation"],
                "direction": {"Red": "harms", "Green": "opens", "Amber": "unclear"}.get(
                    row["GTA Evaluation"], "unclear"
                ),
                "countries": split_list(row["Implementing Jurisdictions"]),
                "level": row["Implementation Level"],
                "targets": row["Eligible Firm"],
                "hs_chapters": hs_chapters(row["Affected Products"]),
                "materials": [],
                "markets": split_list(row["Affected Jurisdictions"]),
                "effective_date": implemented,
                "days_to_effect": (implemented - announced).days
                if pd.notna(implemented) and pd.notna(announced)
                else None,
                "in_force": "removed"
                if pd.notna(removed)
                else "in_force"
                if row["Is In Force"] == "1"
                else "announced",
            }
        )
    return pd.DataFrame.from_records(records)


def as_text(value) -> str:
    return value if isinstance(value, str) else ""


def prepare_articles() -> pd.DataFrame:
    db = firestore.Client(project=PROJECT_ID)
    alerts_by_article: dict[str, list[dict]] = {}
    for doc in db.collection("impacts").stream():
        alert = doc.to_dict()
        alerts_by_article.setdefault(alert.get("articleId") or doc.id.split("~")[0], []).append(alert)
    records = []
    for doc in db.collection("articles").stream():
        article = doc.to_dict()
        alerts = alerts_by_article.get(doc.id, [])
        sample = next((a for a in alerts if not a.get("companyId")), None)
        top = max(alerts, key=lambda a: SEVERITY_RANK.get(a.get("severity"), -1), default=None)
        baseline = sample or top
        mentions = (baseline or {}).get("mentions") or {}
        records.append(
            {
                "item_id": f"article:{doc.id}",
                "source": "article",
                "source_id": doc.id,
                "group_id": f"article:{doc.id}",
                "url": as_text(article.get("url")),
                "title": as_text(article.get("title")),
                "text": as_text(article.get("snippet")),
                "date": pd.to_datetime(article.get("publishedAt"), utc=True, errors="coerce"),
                "publisher": as_text(article.get("publisher")) or as_text(article.get("sourceName")),
                "relevant": bool(article.get("relevant")),
                "alert_count": len(alerts),
                "gemini_severity": (baseline or {}).get("severity"),
                "gemini_severity_from": "sample" if sample else "company" if top else None,
                "gemini_direction": (baseline or {}).get("direction"),
                "gemini_why": as_text((baseline or {}).get("why")),
                "hs_codes": list(mentions.get("hsCodes") or []),
                "materials": list(mentions.get("materials") or []),
                "origins": list(mentions.get("origins") or []),
                "markets": list(mentions.get("markets") or []),
            }
        )
    frame = pd.DataFrame.from_records(records)
    frame["date"] = frame["date"].dt.tz_localize(None)
    return frame


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", choices=["gta", "articles"])
    args = parser.parse_args()
    INTERIM.mkdir(parents=True, exist_ok=True)
    if args.only in (None, "gta"):
        gta = prepare_gta()
        gta.to_parquet(INTERIM / "gta.parquet", index=False)
        print(f"gta: {len(gta)} measures, {gta['group_id'].nunique()} state acts")
        print(gta["measure_type"].value_counts().to_string())
    if args.only in (None, "articles"):
        articles = prepare_articles()
        articles.to_parquet(INTERIM / "articles.parquet", index=False)
        print(
            f"articles: {len(articles)}, relevant {int(articles['relevant'].sum())}, with an alert {int((articles['alert_count'] > 0).sum())}"
        )
        print(articles["gemini_severity"].value_counts(dropna=False).to_string())


if __name__ == "__main__":
    main()
