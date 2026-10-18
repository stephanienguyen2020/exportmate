"""Knowledge graph data: the material chain and the EUDR's commodity → product links.

Each industry's chain (products and links, every link quoting an official text) is built by the
offline pipeline (build_chain.py) and kept as versions in Postgres (`chain_versions`): the files
in data/industries/ are each industry's first published version, and a changed file becomes a
draft a chain admin reviews (services/chain_versions.py). material_chain.json is the
hand-written vocabulary (sources, materials, broad words) laid over the chains (`layer_vocabulary`).

Loaded into Postgres by the reference seed. See README.md here.
"""

import json
from pathlib import Path

GRAPH_DATA_DIR = Path(__file__).resolve().parent / "data"
# Industries the offline pipeline released (build_chain.py --release).
RELEASED_DIR = GRAPH_DATA_DIR / "industries"


def load_graph_file(name: str) -> dict:
    with (GRAPH_DATA_DIR / name).open(encoding="utf-8") as handle:
        return json.load(handle)


def load_released_files() -> list[dict]:
    """Each industry in data/industries/ (build_chain.py --release), without its _about note."""
    return [
        {k: v for k, v in json.loads(path.read_text(encoding="utf-8")).items() if k != "_about"}
        for path in sorted(RELEASED_DIR.glob("*.json"))
    ]


def layer_vocabulary(released: list[dict]) -> dict:
    """The chain the graph is built from: each released industry ({industry, materials, sources}:
    products and links, every link quoting an official text), with material_chain.json laid
    over it, which is written by hand: the sources, the materials (species, local words, wood
    types) and each industry's broad words, which win over the pipeline's."""
    chain = load_graph_file("material_chain.json")
    sources = dict(chain["sources"])
    materials = list(chain["materials"])
    vocabulary = {hand["key"]: hand for hand in chain["industries"]}
    industries = []
    for data in sorted(released, key=lambda d: d["industry"]["key"]):
        hand = {k: v for k, v in vocabulary.get(data["industry"]["key"], {}).items() if v}
        industries.append(data["industry"] | hand)
        materials += data["materials"]
        sources |= data.get("sources", {})
    return {**chain, "sources": sources, "industries": industries, "materials": materials}


def load_chain() -> dict:
    """The chain as the files in git have it (before any version was reviewed in the app)."""
    return layer_vocabulary(load_released_files())
