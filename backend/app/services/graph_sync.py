"""Graph sync: copies the knowledge graph from Postgres into Neo4j, its read model (the
architecture's "Graph sync" upserting nodes and relationships). Postgres stays the source of
truth; each sync rewrites what it covers from Postgres as it is now, so syncs can repeat, come
out of order or be missed (the nightly link weights job runs a full one) and Neo4j still ends up
as Postgres. Walks only trust Neo4j while its chain fingerprint matches (graph_store.py)."""

import hashlib
import logging
import uuid

from neo4j import Driver
from sqlalchemy.orm import Session

from app.core.neo4j import get_neo4j_driver
from app.database.graph_changes import GraphChange
from app.database.models import GraphNodeKind
from app.database.queries import companies as company_queries
from app.database.queries import knowledge_graph as graph_queries
from app.database.queries import neo4j_graph
from app.database.queries import orders as order_queries
from app.database.queries import trade_map as map_queries
from app.services import graph_feedback
from app.services.knowledge_graph import product_of_hs_code
from app.services.trade_map import supplier_name_key

log = logging.getLogger(__name__)


def edges_fingerprint(edge_ids: list[uuid.UUID]) -> str:
    """The same as knowledge_graph.chain_fingerprint for these IDs."""
    return hashlib.md5(",".join(str(i) for i in sorted(edge_ids)).encode()).hexdigest()


def sync_chain(db: Session, driver: Driver) -> dict[str, int]:
    nodes = graph_queries.list_graph_nodes(db)
    edges = graph_queries.list_all_graph_edges(db)
    weights = {(w.from_key, w.to_key): w.weight for w in graph_queries.list_link_weights(db)}
    neo4j_graph.replace_chain(
        driver,
        [
            {
                "key": n.key,
                "kind": n.kind.value,
                "name": n.name,
                "industry": n.industry,
                "hsPrefixes": n.hs_prefixes,
                "aliases": n.aliases,
            }
            for n in nodes
        ],
        [
            {
                "id": str(e.id),
                "fromKey": e.from_key,
                "toKey": e.to_key,
                "relation": e.relation.value,
                "source": e.source_key,
                "quote": e.quote or e.basis,
                "secondary": e.secondary,
                "weight": weights.get((e.from_key, e.to_key), graph_feedback.UNJUDGED_WEIGHT),
            }
            for e in edges
        ],
        edges_fingerprint([e.id for e in edges]),
    )
    return {"nodes": len(nodes), "edges": len(edges)}


def sync_company(db: Session, driver: Driver, company_id: uuid.UUID) -> dict[str, int]:
    products = graph_queries.list_graph_nodes(db, GraphNodeKind.product)
    suppliers = map_queries.list_company_suppliers(db, company_id)
    sourcing = graph_queries.list_supplier_sourcing(db, [s.id for s in suppliers])
    orders = order_queries.list_company_orders(db, company_id)
    neo4j_graph.replace_company(
        driver,
        company_id,
        [
            {
                "id": str(s.id),
                "name": s.name,
                "nameKey": s.name_key,
                "country": s.country_alpha2,
            }
            for s in suppliers
        ],
        [
            {
                "supplierId": str(b.supplier_id),
                "materialKey": b.material_key,
                "country": b.country_alpha2,
                "formKey": b.form_key,
                "basis": b.basis,
            }
            for b in sourcing
        ],
        [
            {
                "id": str(o.id),
                "externalId": o.external_id,
                "product": o.product,
                "hsCode": o.hs_code,
                "status": o.status.value,
                "shipDate": o.ship_date.isoformat(),
                "supplierKey": supplier_name_key(o.supplier),
                "productKey": node.key
                if (node := product_of_hs_code(o.hs_code, products))
                else None,
            }
            for o in orders
        ],
    )
    return {"suppliers": len(suppliers), "orders": len(orders)}


def sync_change(db: Session, change: GraphChange) -> bool:
    """Syncs what a change event names. False when Neo4j isn't configured."""
    driver = get_neo4j_driver()
    if driver is None:
        return False
    if change.every_company:
        sync_all(db)
        return True
    if change.chain:
        counts = sync_chain(db, driver)
        log.info("graph.chain_synced", extra=counts)
    companies = change.company_ids | graph_queries.list_supplier_company_ids(
        db, change.supplier_ids
    )
    for company_id in companies:
        counts = sync_company(db, driver, company_id)
        log.info("graph.company_synced", extra={"company_id": str(company_id), **counts})
    return True


def sync_all(db: Session) -> dict[str, int] | None:
    """Everything: the chain and every company, and companies gone from Postgres removed."""
    driver = get_neo4j_driver()
    if driver is None:
        return None
    neo4j_graph.ensure_constraints(driver)
    counts = sync_chain(db, driver)
    company_ids = company_queries.list_company_ids(db)
    for company_id in company_ids:
        sync_company(db, driver, company_id)
    neo4j_graph.remove_other_companies(driver, company_ids)
    counts["companies"] = len(company_ids)
    log.info("graph.synced", extra=counts)
    return counts
