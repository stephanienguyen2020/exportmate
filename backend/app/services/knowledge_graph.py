"""The knowledge graph walk: from what a news article names to the open orders it may hit.

An article names materials ("acacia logs"), HS codes, the countries goods come from and the
markets a measure covers (`GraphMentions`). An open order is reached in one of two ways:

- Through its supplier: the supplier buys a named material, or buys from a named country (both,
  when the article names both). The path follows the material chain (graph_edges) from the form
  the supplier buys to the order's product: "Binh Phu Wood buys acacia logs from Laos; logs →
  veneer → plywood, this order's product". When the article also names a product of the chain
  (logs, HS 4403), the order's product must be made from it.
- By HS heading: the order's HS heading is one the article names (the rule News watch used
  before the graph).

When the article names markets, only orders shipping to one of them are reached. The walk is
code, not AI: the same mentions give the same paths, and each link cites its source.
"""

import re
import uuid
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.database.models import GraphEdge, GraphNode, GraphNodeKind, Order, Supplier
from app.database.models import SupplierSourcing as Sourcing
from app.database.queries import knowledge_graph as graph_queries
from app.database.queries import trade_map as map_queries
from app.services.trade_map import supplier_name_key

MAX_LINKS = 4  # the longest chain followed, e.g. logs → veneer → plywood → furniture
RELATION_WORDS = {"used_to_make": "used to make", "by_product": "leaves"}


@dataclass(frozen=True)
class GraphMentions:
    materials: tuple[str, ...] = ()  # as the article words them
    hs_codes: tuple[str, ...] = ()
    origin_countries: tuple[str, ...] = ()  # ISO alpha-2: where goods or materials come from
    markets: tuple[str, ...] = ()  # market codes ("EU", "US") a measure covers
    # How the reason names what the alert named, e.g. "like PLY-18 Acacia plywood named in this
    # alert".
    named_as: str = "named in this alert"


@dataclass(frozen=True)
class GraphPathStep:
    kind: str  # "mention", "supplier", "product" or "order"
    label: str
    link: str | None = None  # how it follows from the step before
    source_title: str | None = None
    source_url: str | None = None
    quote: str | None = None


@dataclass(frozen=True)
class GraphMatch:
    order: Order
    market: str | None
    path: list[GraphPathStep]
    reason: str


def _digits(code: object) -> str:
    return re.sub(r"\D", "", str(code or ""))


def hs_heading(hs_code: object) -> str:
    """The first four digits of an HS code ("4412.33" → "4412"); "" when there are fewer."""
    digits = _digits(hs_code)
    return digits[:4] if len(digits) >= 4 else ""


def named_materials(words: tuple[str, ...], materials: list[GraphNode]) -> list[GraphNode]:
    """Material nodes one of whose names appears as whole words in what the article named."""
    texts = [w.lower() for w in words if w.strip()]
    return [
        node
        for node in materials
        if any(
            re.search(rf"\b{re.escape(alias)}\b", text) for alias in node.aliases for text in texts
        )
    ]


def product_of_hs_code(hs_code: object, products: list[GraphNode]) -> GraphNode | None:
    """The chain step an HS code belongs to: the product with the longest matching prefix."""
    digits = _digits(hs_code)
    best: tuple[int, GraphNode] | None = None
    for node in products:
        for prefix in node.hs_prefixes:
            if digits.startswith(prefix) and (best is None or len(prefix) > best[0]):
                best = (len(prefix), node)
    return best[1] if best else None


def _hs_label(node: GraphNode) -> str:
    codes = ", ".join(f"{p[:4]}.{p[4:]}" if len(p) > 4 else p for p in node.hs_prefixes[:2])
    return f"{node.name} (HS {codes})"


class GraphWalker:
    """The graph for one company, loaded once and walked for each alert."""

    def __init__(self, db: Session, company_id: uuid.UUID):
        self.db = db
        nodes = graph_queries.list_graph_nodes(db)
        self.nodes = {n.key: n for n in nodes}
        self.products = [n for n in nodes if n.kind == GraphNodeKind.product]
        self.materials = [n for n in nodes if n.kind == GraphNodeKind.material]
        self.sources = {s.key: s for s in graph_queries.list_graph_sources(db)}
        self.sourcing = graph_queries.list_company_sourcing(db, company_id)
        countries = map_queries.list_countries(db)
        self.country_names = {c.alpha2: c.name for c in countries}
        self.market_codes = {m.code for m in map_queries.list_markets(db)}
        self.market_of_country = {c.alpha2: c.market_code for c in countries if c.market_code}

    def find_matches(
        self, mentions: GraphMentions, open_orders: list[tuple[Order, str | None]]
    ) -> list[GraphMatch]:
        materials = {n.key for n in named_materials(mentions.materials, self.materials)}
        origins = {c.upper() for c in mentions.origin_countries}
        markets = self.known_markets(mentions.markets)
        headings = {hs_heading(c) for c in mentions.hs_codes} - {""}
        named_products = {
            node.key
            for code in mentions.hs_codes
            if len(_digits(code)) >= 4 and (node := product_of_hs_code(code, self.products))
        }
        buying = [
            (sourcing, supplier)
            for sourcing, supplier in self.sourcing
            if (materials or origins)
            and (not materials or sourcing.material_key in materials)
            and (not origins or sourcing.country_alpha2 in origins)
        ]
        chains = self._shortest_chains(
            {s.form_key for s, _ in buying if s.form_key} | named_products
        )
        matches = []
        for order, market in open_orders:
            if markets and market not in markets:
                continue
            match = self._through_supplier(order, market, buying, named_products, chains, mentions)
            if match is None and hs_heading(order.hs_code) in headings:
                where = f" and ships to {market}" if markets else ""
                heading = hs_heading(order.hs_code)
                match = GraphMatch(
                    order=order,
                    market=market,
                    path=[
                        GraphPathStep("mention", f"HS {heading}"),
                        GraphPathStep(
                            "order", f"{order.external_id} {order.product}", "same HS heading"
                        ),
                    ],
                    reason=f"HS {heading}{where}, {mentions.named_as}."[:500],
                )
            if match:
                matches.append(match)
        return matches

    def known_markets(self, codes: tuple[str, ...]) -> set[str]:
        """Our market codes for what the article named: a country counts as its market ("GB" is
        UK, "DE" is EU); codes we don't know are left out, so they don't hide every order."""
        found = set()
        for code in codes:
            if code in self.market_codes:
                found.add(code)
            elif code in self.market_of_country:
                found.add(self.market_of_country[code])
        return found

    def _shortest_chains(self, start_keys: set[str]) -> dict[tuple[str, str], list[GraphEdge]]:
        rows = graph_queries.walk_downstream(self.db, start_keys, MAX_LINKS)
        edges = {
            e.id: e
            for e in graph_queries.list_graph_edges(
                self.db, {edge_id for r in rows for edge_id in r.edge_ids}
            )
        }
        chains: dict[tuple[str, str], list[GraphEdge]] = {}
        for row in rows:  # shortest first
            chains.setdefault((row.start_key, row.node_key), [edges[i] for i in row.edge_ids])
        return chains

    def _through_supplier(
        self,
        order: Order,
        market: str | None,
        buying: list[tuple[Sourcing, Supplier]],
        named_products: set[str],
        chains: dict[tuple[str, str], list[GraphEdge]],
        mentions: GraphMentions,
    ) -> GraphMatch | None:
        order_product = product_of_hs_code(order.hs_code, self.products)
        if named_products and not (
            order_product and any((named, order_product.key) in chains for named in named_products)
        ):
            return None  # the article is about a product this order isn't made from
        for sourcing, supplier in buying:
            if supplier.name_key != supplier_name_key(order.supplier):
                continue
            chain = (
                chains.get((sourcing.form_key, order_product.key))
                if sourcing.form_key and order_product
                else None
            )
            return self._supplier_match(order, market, sourcing, supplier, chain, mentions)
        return None

    def _supplier_match(
        self,
        order: Order,
        market: str | None,
        sourcing: Sourcing,
        supplier: Supplier,
        chain: list[GraphEdge] | None,
        mentions: GraphMentions,
    ) -> GraphMatch:
        material = self.nodes[sourcing.material_key].name
        country = self.country_names.get(sourcing.country_alpha2, sourcing.country_alpha2)
        form = self.nodes.get(sourcing.form_key) if sourcing.form_key else None
        named = ", ".join([*mentions.materials, *mentions.origin_countries]) or "this alert"
        path = [
            GraphPathStep("mention", named),
            GraphPathStep(
                "supplier",
                supplier.name,
                f"buys {material.lower()} from {country} ({sourcing.basis})",
            ),
        ]
        if form and chain is not None:
            path.append(GraphPathStep("product", _hs_label(form), "bought as"))
            for edge in chain:
                source = self.sources.get(edge.source_key)
                path.append(
                    GraphPathStep(
                        "product",
                        _hs_label(self.nodes[edge.to_key]),
                        RELATION_WORDS[edge.relation.value],
                        source.title if source else None,
                        source.url if source else None,
                        edge.quote or edge.basis,
                    )
                )
        path.append(
            GraphPathStep(
                "order", f"{order.external_id} {order.product}", f"supplied by {supplier.name}"
            )
        )
        steps = " → ".join(s.label for s in path if s.kind == "product")
        reason = f"{supplier.name} buys {material.lower()} from {country}"
        reason += f"; {steps}, this order's product." if steps else " and supplies this order."
        return GraphMatch(order=order, market=market, path=path, reason=reason[:500])
