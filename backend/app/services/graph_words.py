"""How the words a news article or a document uses name knowledge graph nodes: a species
("acacia"), a broad word for several materials ("timber", "hardwood") or a chain product
("plywood"). Pure: used by the graph walk and by sourcing suggestions."""

import re

from app.database.models import GraphNode


def _names_in(alias: str, texts: list[str]) -> bool:
    return any(re.search(rf"\b{re.escape(alias)}\b", text) for text in texts)


def named_nodes(words: tuple[str, ...], nodes: list[GraphNode]) -> list[GraphNode]:
    """Nodes one of whose names appears as whole words in what the article named."""
    texts = [w.lower() for w in words if w.strip()]
    return [node for node in nodes if any(_names_in(alias, texts) for alias in node.aliases)]


def broad_materials(
    words: tuple[str, ...], commodities: list[GraphNode], materials: list[GraphNode]
) -> list[GraphNode]:
    """The materials a broad word stands for ("timber": every wood; "hardwood": the
    non-coniferous and tropical ones). In one phrase the more specific word wins: "tropical
    timber" is the tropical woods, not every wood."""
    found: dict[str, GraphNode] = {}
    for text in (w.lower() for w in words if w.strip()):
        for commodity in commodities:
            terms = commodity.details.get("genericTerms") or {}
            named = [t for t in terms if _names_in(t, [text])]
            for term in named:
                if any(term != other and term in other for other in named):
                    continue
                wood_types = terms[term]
                for node in materials:
                    if node.industry == commodity.industry and (
                        not wood_types or node.details.get("woodType") in wood_types
                    ):
                        found[node.key] = node
    return list(found.values())
