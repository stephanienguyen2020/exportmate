"""Knowledge graph data: the material chain and the EUDR's commodity → product links.

The chain is material_chain.json (hand-written: wood) plus each industry the offline pipeline
released into data/industries/ (build_chain.py); `load_chain` merges them.

Loaded into Postgres by the reference seed (docs/NEWS_IMPACT_PLAN.md, phase 1). See README.md here.
"""

import json
from pathlib import Path

GRAPH_DATA_DIR = Path(__file__).resolve().parent / "data"
# Industries the offline pipeline released (build_chain.py --release).
RELEASED_DIR = GRAPH_DATA_DIR / "industries"


def load_graph_file(name: str) -> dict:
    with (GRAPH_DATA_DIR / name).open(encoding="utf-8") as handle:
        return json.load(handle)


def load_chain() -> dict:
    """The chain the seed loads: each industry released by the offline pipeline
    (data/industries/*.json: products and links, every link quoting an official text), and
    material_chain.json, which is written by hand: the sources, the materials (species, local
    words, wood types) and each industry's broad words, which win over the pipeline's."""
    chain = load_graph_file("material_chain.json")
    sources = dict(chain["sources"])
    materials = list(chain["materials"])
    vocabulary = {hand["key"]: hand for hand in chain["industries"]}
    industries = []
    for path in sorted(RELEASED_DIR.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        hand = {k: v for k, v in vocabulary.get(data["industry"]["key"], {}).items() if v}
        industries.append(data["industry"] | hand)
        materials += data["materials"]
        sources |= data.get("sources", {})
    return {**chain, "sources": sources, "industries": industries, "materials": materials}
