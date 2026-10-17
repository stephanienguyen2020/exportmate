import uuid
from dataclasses import dataclass

from sqlalchemy import Text, any_, cast, delete, func, literal, select
from sqlalchemy.dialects.postgresql import ARRAY, UUID, array, insert
from sqlalchemy.orm import Session

from app.database.models import (
    GraphEdge,
    GraphNode,
    GraphNodeKind,
    GraphSource,
    Supplier,
    SupplierSourcing,
)


@dataclass(frozen=True)
class GraphWalkRow:
    start_key: str
    node_key: str
    depth: int
    edge_ids: list[uuid.UUID]  # the edges walked, in order


# --- Reads


def list_graph_nodes(db: Session, kind: GraphNodeKind | None = None) -> list[GraphNode]:
    query = select(GraphNode).order_by(GraphNode.key)
    if kind:
        query = query.where(GraphNode.kind == kind)
    return list(db.scalars(query))


def list_graph_edges(db: Session, edge_ids: set[uuid.UUID]) -> list[GraphEdge]:
    if not edge_ids:
        return []
    return list(db.scalars(select(GraphEdge).where(GraphEdge.id.in_(edge_ids))))


def list_graph_sources(db: Session) -> list[GraphSource]:
    return list(db.scalars(select(GraphSource)))


def walk_downstream(db: Session, start_keys: set[str], max_depth: int) -> list[GraphWalkRow]:
    """Every node reachable from each start node along the links' direction (what it is used
    to make, what is left over from making it), at most `max_depth` links away, with the
    links walked. A start node is reached from itself at depth 0. Cycles are not followed."""
    if not start_keys:
        return []
    walk = (
        select(
            GraphNode.key.label("start_key"),
            GraphNode.key.label("node_key"),
            literal(0).label("depth"),
            cast(array([], type_=UUID(as_uuid=True)), ARRAY(UUID(as_uuid=True))).label("edge_ids"),
            cast(array([GraphNode.key]), ARRAY(Text)).label("visited"),
        )
        .where(GraphNode.key.in_(start_keys))
        .cte("walk", recursive=True)
    )
    step = (
        select(
            walk.c.start_key,
            GraphEdge.to_key,
            walk.c.depth + 1,
            func.array_append(walk.c.edge_ids, GraphEdge.id),
            func.array_append(walk.c.visited, cast(GraphEdge.to_key, Text)),
        )
        .join(GraphEdge, GraphEdge.from_key == walk.c.node_key)
        .where(walk.c.depth < max_depth, ~(GraphEdge.to_key == any_(walk.c.visited)))
    )
    walk = walk.union_all(step)
    rows = db.execute(
        select(walk.c.start_key, walk.c.node_key, walk.c.depth, walk.c.edge_ids).order_by(
            walk.c.depth
        )
    )
    return [GraphWalkRow(r.start_key, r.node_key, r.depth, list(r.edge_ids)) for r in rows]


def list_supplier_sourcing(db: Session, supplier_ids: list[uuid.UUID]) -> list[SupplierSourcing]:
    if not supplier_ids:
        return []
    return list(
        db.scalars(
            select(SupplierSourcing)
            .where(SupplierSourcing.supplier_id.in_(supplier_ids))
            .order_by(SupplierSourcing.material_key, SupplierSourcing.country_alpha2)
        )
    )


def list_company_sourcing(
    db: Session, company_id: uuid.UUID
) -> list[tuple[SupplierSourcing, Supplier]]:
    rows = db.execute(
        select(SupplierSourcing, Supplier)
        .join(Supplier, Supplier.id == SupplierSourcing.supplier_id)
        .where(Supplier.company_id == company_id)
        .order_by(Supplier.name, SupplierSourcing.material_key)
    )
    return [(sourcing, supplier) for sourcing, supplier in rows]


# --- Seed writes


def _upsert(db: Session, model, rows: list[dict], key: list[str]) -> None:
    if not rows:
        return
    stmt = insert(model).values(rows)
    updates = {c: stmt.excluded[c] for c in rows[0] if c not in key and c != "id"}
    db.execute(stmt.on_conflict_do_update(index_elements=key, set_=updates))


def upsert_graph_sources(db: Session, rows: list[dict]) -> None:
    _upsert(db, GraphSource, rows, ["key"])


def upsert_graph_nodes(db: Session, rows: list[dict]) -> None:
    _upsert(db, GraphNode, rows, ["key"])


def replace_graph_edges(db: Session, rows: list[dict]) -> None:
    """The data file is the whole set of links: links no longer in it are removed."""
    db.execute(delete(GraphEdge))
    if rows:
        db.execute(insert(GraphEdge).values(rows))


def replace_supplier_sourcing(db: Session, supplier_id: uuid.UUID, rows: list[dict]) -> None:
    db.execute(delete(SupplierSourcing).where(SupplierSourcing.supplier_id == supplier_id))
    if rows:
        db.execute(insert(SupplierSourcing).values(rows))
