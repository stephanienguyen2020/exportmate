"""Seed files: data loaded into Postgres by the seed commands, never read by the API."""

import json
from pathlib import Path

SEED_DIR = Path(__file__).resolve().parent


def load_seed_file(name: str) -> dict:
    with (SEED_DIR / name).open(encoding="utf-8") as handle:
        return json.load(handle)
