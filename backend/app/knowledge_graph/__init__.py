"""Knowledge graph data: the material chain and the EUDR's commodity → product links.

Loaded into Postgres by the reference seed (docs/NEWS_IMPACT_PLAN.md, phase 1). See README.md here.
"""

import json
from pathlib import Path

GRAPH_DATA_DIR = Path(__file__).resolve().parent / "data"


def load_graph_file(name: str) -> dict:
    with (GRAPH_DATA_DIR / name).open(encoding="utf-8") as handle:
        return json.load(handle)
