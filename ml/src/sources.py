"""Every news article we have, in one shape: the scan's (source "article", the test set) and the
GDELT archive's (source "archive", training only)."""

from pathlib import Path

import pandas as pd

INTERIM = Path(__file__).resolve().parent.parent / "data/interim"
COLUMNS = ["item_id", "source", "title", "text", "date", "publisher"]


def all_articles() -> pd.DataFrame:
    frames = [pd.read_parquet(INTERIM / "articles.parquet")[COLUMNS]]
    if (INTERIM / "collected.parquet").exists():
        frames.append(pd.read_parquet(INTERIM / "collected.parquet")[COLUMNS])
    return pd.concat(frames, ignore_index=True)
