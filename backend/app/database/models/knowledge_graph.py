"""Knowledge graph tables (docs/NEWS_IMPACT_PLAN.md, phase 1).

Shared reference data, from app/knowledge_graph/data/: the sources links cite, the nodes
(EUDR commodities, products by HS code, materials) and the links between products ("logs are
used to make veneer"). Company data: which material each supplier buys, from which country.
Orders and suppliers are already tables; a walk joins them to these rows instead of copying
them into a separate graph.
"""

import enum
import uuid

from sqlalchemy import Boolean, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database.models.base import Base, id_column, pg_enum


class GraphNodeKind(str, enum.Enum):
    commodity = "commodity"  # an EUDR commodity, e.g. wood
    product = "product"  # a step of an industry's material chain, e.g. plywood (HS 4412)
    material = "material"  # what news and documents name, e.g. acacia


class GraphRelation(str, enum.Enum):
    used_to_make = "used_to_make"
    by_product = "by_product"


class GraphSource(Base):
    """A text the graph's links cite (EUDR Annex I, FAO definitions, HS headings)."""

    __tablename__ = "graph_sources"
    key: Mapped[str] = mapped_column(String(40), primary_key=True)  # "fao-jfsq"
    title: Mapped[str] = mapped_column(Text, nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)


class GraphNode(Base):
    __tablename__ = "graph_nodes"
    # "commodity.wood", "wood.plywood", "material.acacia"
    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    kind: Mapped[GraphNodeKind] = mapped_column(
        pg_enum(GraphNodeKind, "graph_node_kind"), nullable=False
    )
    industry: Mapped[str | None] = mapped_column(String(40))  # "wood"
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    # HS code prefixes, digits only: a product's codes, or every code a commodity covers.
    hs_prefixes: Mapped[list[str]] = mapped_column(ARRAY(String(12)), nullable=False, default=list)
    # Lower-case words that name a material in news and documents ("acacia", "keo").
    aliases: Mapped[list[str]] = mapped_column(ARRAY(String(100)), nullable=False, default=list)
    # Product: stage. Material: scientific names, wood type. Commodity: the EUDR lines.
    details: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    source_key: Mapped[str | None] = mapped_column(ForeignKey("graph_sources.key"))


class GraphEdge(Base):
    """One product used to make another (or left over from making it), citing a source."""

    __tablename__ = "graph_edges"
    id: Mapped[uuid.UUID] = id_column()
    from_key: Mapped[str] = mapped_column(
        ForeignKey("graph_nodes.key", ondelete="CASCADE"), index=True, nullable=False
    )
    to_key: Mapped[str] = mapped_column(
        ForeignKey("graph_nodes.key", ondelete="CASCADE"), index=True, nullable=False
    )
    relation: Mapped[GraphRelation] = mapped_column(
        pg_enum(GraphRelation, "graph_relation"), nullable=False
    )
    source_key: Mapped[str] = mapped_column(ForeignKey("graph_sources.key"), nullable=False)
    quote: Mapped[str | None] = mapped_column(Text)  # the source's words, when it says so
    basis: Mapped[str | None] = mapped_column(Text)  # otherwise why, from the source
    # Who checked the link, the verdict and why: {"verdict", "note", "by", "on"}.
    ai_check: Mapped[dict | None] = mapped_column(JSONB)
    # A less common route (veneer is mostly a furniture surface): used only when no equally
    # short path avoids it.
    secondary: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    __table_args__ = (UniqueConstraint("from_key", "to_key", "relation"),)


class SupplierSourcing(Base):
    """A material a supplier buys, the country it comes from, and in what form."""

    __tablename__ = "supplier_sourcing"
    id: Mapped[uuid.UUID] = id_column()
    supplier_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("suppliers.id", ondelete="CASCADE"), index=True, nullable=False
    )
    material_key: Mapped[str] = mapped_column(ForeignKey("graph_nodes.key"), nullable=False)
    country_alpha2: Mapped[str] = mapped_column(ForeignKey("countries.alpha2"), nullable=False)
    # The chain step it is bought as, e.g. "wood.roundwood" (logs) or "wood.veneer".
    form_key: Mapped[str | None] = mapped_column(ForeignKey("graph_nodes.key"))
    basis: Mapped[str] = mapped_column(Text, nullable=False)  # how we know: "species document"
    __table_args__ = (UniqueConstraint("supplier_id", "material_key", "country_alpha2"),)
