"""Pick what to rate → labels/to_rate.csv (empty `our_severity`; rate it by labels/RUBRIC.md).

    uv run python src/sample.py [--gta=300] [--targeted=120] [--seed=7]

- Every article that ever got an alert: they're the test set, and Gemini rated them (its baseline).
- GTA measures sampled evenly across measure type × GTA evaluation, not in proportion (820 are
  subsidies), at most one per State Act (an act's interventions share a title).
- Targeted GTA measures: import-side measures (tariffs, trade defence, bans, quotas, licences) by
  our markets on wood or furniture (HS 44, 94), two thirds of them narrow (≤10 HS chapters). The even
  sample is ~95% `low` for a wood exporter; these are where `medium` and `high` live.

Already-rated items (labels/rated.csv) are left out, so a rerun only adds new ones. The file never
shows Gemini's severity, so the rater isn't anchored by it.
"""

import argparse
from pathlib import Path

import pandas as pd

ML = Path(__file__).resolve().parent.parent
INTERIM = ML / "data/interim"
TO_RATE = ML / "labels/to_rate.csv"
RATED = ML / "labels/rated.csv"
# Where the demo exporter sells (GTA's names; EU members act through "the EU" as a whole list).
OUR_MARKETS = {
    "United States of America",
    "Canada",
    "United Kingdom",
    "Japan",
    "Republic of Korea",
    "Australia",
    "Germany",
    "France",
    "Netherlands",
    "Italy",
    "Belgium",
    "Spain",
    "Poland",
}
IMPORT_SIDE = {"tariff", "trade_defence", "import_ban", "import_quota", "import_licence"}


def short_list(values, limit=6) -> str:
    values = list(values)
    return ", ".join(values[:limit]) + (f" (+{len(values) - limit})" if len(values) > limit else "")


def gta_details(row) -> str:
    when = row["date"].date() if pd.notna(row["date"]) else "?"
    effect = row["effective_date"].date() if pd.notna(row["effective_date"]) else "?"
    return (
        f"{row['gta_intervention_type']} ({row['gta_evaluation']}); by {short_list(row['countries'])}"
        f" [{row['level']}, targets {row['targets']}]; hits {short_list(row['markets'])};"
        f" HS chapters {short_list(row['hs_chapters'], 10)}; announced {when}, effective {effect}, {row['in_force']}"
    )


def sample_gta(gta: pd.DataFrame, count: int, seed: int) -> pd.DataFrame:
    one_per_act = gta.sample(frac=1, random_state=seed).drop_duplicates("group_id")
    strata = [group for _, group in one_per_act.groupby(["measure_type", "gta_evaluation"])]
    picked, round_ = [], 0
    while len(picked) < count and any(round_ < len(group) for group in strata):
        for group in strata:
            if round_ < len(group) and len(picked) < count:
                picked.append(group.iloc[round_])
        round_ += 1
    return pd.DataFrame(picked)


def sample_targeted(gta: pd.DataFrame, count: int, seed: int, skip_groups: set[str]) -> pd.DataFrame:
    ours = gta[
        gta["countries"].apply(lambda countries: bool(OUR_MARKETS & set(countries)))
        & gta["hs_chapters"].apply(lambda chapters: bool({"44", "94"} & set(chapters)))
        & gta["measure_type"].isin(IMPORT_SIDE)
        & ~gta["group_id"].isin(skip_groups)
    ]
    one_per_act = ours.sample(frac=1, random_state=seed).drop_duplicates("group_id")
    narrow = one_per_act[one_per_act["hs_chapters"].apply(len) <= 10]
    broad = one_per_act[one_per_act["hs_chapters"].apply(len) > 10]
    take_narrow = min(len(narrow), count * 2 // 3)
    return pd.concat([narrow.head(take_narrow), broad.head(count - take_narrow)])


def headline_key(titles: pd.Series) -> pd.Series:
    return (
        titles.str.split(" - ").str[0].str.lower().str.replace(r"[^a-z0-9 ]", "", regex=True).str.slice(0, 60)
    )


def archive_to_rate(scan_articles: pd.DataFrame) -> pd.DataFrame:
    """Every collected archive headline (collect.py), minus any whose headline the scan also read:
    those are test articles and must not reappear as training."""
    path = INTERIM / "collected.parquet"
    if not path.exists():
        return pd.DataFrame(columns=["item_id", "source", "title", "text", "details"])
    archive = pd.read_parquet(path)
    archive = archive[~headline_key(archive["title"]).isin(set(headline_key(scan_articles["title"])))]
    return pd.DataFrame(
        {
            "item_id": archive["item_id"],
            "source": "archive",
            "title": archive["title"],
            "text": "",
            "details": archive["publisher"] + ", " + archive["date"].dt.date.astype(str),
        }
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gta", type=int, default=300)
    parser.add_argument("--targeted", type=int, default=120)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    articles = pd.read_parquet(INTERIM / "articles.parquet")
    gta = pd.read_parquet(INTERIM / "gta.parquet")
    rated = set(pd.read_csv(RATED)["item_id"]) if RATED.exists() else set()

    alerted = articles[articles["alert_count"] > 0]
    article_rows = pd.DataFrame(
        {
            "item_id": alerted["item_id"],
            "source": "article",
            "title": alerted["title"],
            "text": alerted["text"],
            "details": alerted["publisher"] + ", " + alerted["date"].dt.date.astype(str),
        }
    )
    even = sample_gta(gta, args.gta, args.seed)
    targeted = sample_targeted(gta, args.targeted, args.seed, set(even["group_id"]))
    picked = pd.concat([even, targeted])
    gta_rows = pd.DataFrame(
        {
            "item_id": picked["item_id"],
            "source": "gta",
            "title": picked["title"],
            "text": "",
            "details": picked.apply(gta_details, axis=1),
        }
    )
    archive_rows = archive_to_rate(articles)
    rows = pd.concat([article_rows, gta_rows, archive_rows]).sample(frac=1, random_state=args.seed)
    rows = rows[~rows["item_id"].isin(rated)]
    rows[["our_severity", "note", "rater"]] = ""
    TO_RATE.parent.mkdir(parents=True, exist_ok=True)
    rows.to_csv(TO_RATE, index=False, encoding="utf-8")
    print(f"{len(rows)} new to rate ({len(rated)} already rated) to {TO_RATE.relative_to(ML)}")
    print(rows["source"].value_counts().to_string())


if __name__ == "__main__":
    main()
