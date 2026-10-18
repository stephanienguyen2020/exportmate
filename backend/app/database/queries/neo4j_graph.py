"""Cypher for the knowledge graph's read model in Neo4j (the only place that builds Cypher, as
the other query modules are for SQL). The model, each part copied from the Postgres table named:

    (:GraphNode:Product|Material|Commodity {key})          graph_nodes
    (:Product)-[:USED_TO_MAKE|BY_PRODUCT {id, weight}]->   graph_edges (+ graph_link_weights)
    (:Supplier {id, companyId})-[:BUYS {country, form}]->(:Material)   suppliers, supplier_sourcing
    (:Supplier)-[:SUPPLIES]->(:Order {id, companyId})      orders (by supplier name)
    (:Order)-[:IS_PRODUCT]->(:Product)                     orders (by HS code)
    (:SyncState {name: "chain", fingerprint})              which graph_edges rows it holds
"""

import uuid
from dataclasses import dataclass

from neo4j import Driver, ManagedTransaction

from app.core.neo4j import neo4j_database
from app.database.queries.knowledge_graph import GraphWalkRow

RELATION_TYPES = {"used_to_make": "USED_TO_MAKE", "by_product": "BY_PRODUCT"}
NODE_LABELS = {"product": "Product", "material": "Material", "commodity": "Commodity"}


@dataclass(frozen=True)
class Neo4jWalk:
    fingerprint: str | None  # of the graph_edges rows Neo4j holds; None before the first sync
    rows: list[GraphWalkRow]


def ensure_constraints(driver: Driver) -> None:
    for label, field in (("GraphNode", "key"), ("Supplier", "id"), ("Order", "id")):
        driver.execute_query(
            f"CREATE CONSTRAINT {label.lower()}_{field} IF NOT EXISTS "
            f"FOR (n:{label}) REQUIRE n.{field} IS UNIQUE",
            database_=neo4j_database(),
        )


# --- The shared chain


def _replace_chain(
    tx: ManagedTransaction, nodes: list[dict], edges: list[dict], fingerprint: str
) -> None:
    tx.run(
        "MATCH (n:GraphNode) WHERE NOT n.key IN $keys DETACH DELETE n",
        keys=[n["key"] for n in nodes],
    )
    for kind, label in NODE_LABELS.items():
        tx.run(
            f"UNWIND $nodes AS row MERGE (n:GraphNode {{key: row.key}}) SET n:{label}, "
            "n.name = row.name, n.industry = row.industry, n.hsPrefixes = row.hsPrefixes, "
            "n.aliases = row.aliases",
            nodes=[n for n in nodes if n["kind"] == kind],
        )
    tx.run("MATCH (:GraphNode)-[r:USED_TO_MAKE|BY_PRODUCT]->(:GraphNode) DELETE r")
    for relation, rel_type in RELATION_TYPES.items():
        tx.run(
            "UNWIND $edges AS row "
            "MATCH (a:GraphNode {key: row.fromKey}) MATCH (b:GraphNode {key: row.toKey}) "
            f"CREATE (a)-[:{rel_type} {{id: row.id, source: row.source, quote: row.quote, "
            "secondary: row.secondary, weight: row.weight}]->(b)",
            edges=[e for e in edges if e["relation"] == relation],
        )
    tx.run(
        "MERGE (s:SyncState {name: 'chain'}) "
        "SET s.fingerprint = $fingerprint, s.edges = $count, s.syncedAt = datetime()",
        fingerprint=fingerprint,
        count=len(edges),
    )


def replace_chain(driver: Driver, nodes: list[dict], edges: list[dict], fingerprint: str) -> None:
    """The graph's nodes and links, in one transaction: walks see the old chain or the new."""
    with driver.session(database=neo4j_database()) as session:
        session.execute_write(_replace_chain, nodes, edges, fingerprint)


# --- A company's suppliers and orders


def _replace_company(
    tx: ManagedTransaction,
    company_id: str,
    suppliers: list[dict],
    sourcing: list[dict],
    orders: list[dict],
) -> None:
    tx.run(
        "MATCH (n) WHERE (n:Supplier OR n:Order) AND n.companyId = $company DETACH DELETE n",
        company=company_id,
    )
    tx.run(
        "UNWIND $suppliers AS row CREATE (:Supplier {id: row.id, companyId: $company, "
        "name: row.name, nameKey: row.nameKey, country: row.country})",
        suppliers=suppliers,
        company=company_id,
    )
    tx.run(
        "UNWIND $sourcing AS row "
        "MATCH (s:Supplier {id: row.supplierId}) MATCH (m:GraphNode {key: row.materialKey}) "
        "CREATE (s)-[:BUYS {country: row.country, form: row.formKey, basis: row.basis}]->(m)",
        sourcing=sourcing,
    )
    tx.run(
        "UNWIND $orders AS row "
        "CREATE (o:Order {id: row.id, companyId: $company, externalId: row.externalId, "
        "product: row.product, hsCode: row.hsCode, status: row.status, shipDate: row.shipDate}) "
        "WITH o, row "
        "OPTIONAL MATCH (s:Supplier {companyId: $company, nameKey: row.supplierKey}) "
        "FOREACH (_ IN CASE WHEN s IS NULL THEN [] ELSE [1] END | CREATE (s)-[:SUPPLIES]->(o)) "
        "WITH o, row "
        "OPTIONAL MATCH (p:GraphNode {key: row.productKey}) "
        "FOREACH (_ IN CASE WHEN p IS NULL THEN [] ELSE [1] END | CREATE (o)-[:IS_PRODUCT]->(p))",
        orders=orders,
        company=company_id,
    )


def replace_company(
    driver: Driver,
    company_id: uuid.UUID,
    suppliers: list[dict],
    sourcing: list[dict],
    orders: list[dict],
) -> None:
    with driver.session(database=neo4j_database()) as session:
        session.execute_write(_replace_company, str(company_id), suppliers, sourcing, orders)


def remove_other_companies(driver: Driver, company_ids: list[uuid.UUID]) -> None:
    """Suppliers and orders of companies no longer in Postgres."""
    driver.execute_query(
        "MATCH (n) WHERE (n:Supplier OR n:Order) AND NOT n.companyId IN $companies DETACH DELETE n",
        companies=[str(c) for c in company_ids],
        database_=neo4j_database(),
    )


# --- The walk


def _walk(tx: ManagedTransaction, start_keys: list[str], max_depth: int) -> Neo4jWalk:
    state = tx.run("MATCH (s:SyncState {name: 'chain'}) RETURN s.fingerprint AS f").single()
    # Simple paths only (no node twice), as the Postgres walk; a start is reached at depth 0.
    result = tx.run(
        "UNWIND $starts AS start MATCH (s:GraphNode {key: start}) "
        f"MATCH p = (s)-[:USED_TO_MAKE|BY_PRODUCT*0..{int(max_depth)}]->(n:GraphNode) "
        "WHERE ALL(x IN nodes(p) WHERE single(y IN nodes(p) WHERE y = x)) "
        "RETURN start, n.key AS node, length(p) AS depth, [r IN relationships(p) | r.id] AS edges "
        "ORDER BY depth",
        starts=start_keys,
    )
    rows = [
        GraphWalkRow(r["start"], r["node"], r["depth"], [uuid.UUID(e) for e in r["edges"]])
        for r in result
    ]
    return Neo4jWalk(state["f"] if state else None, rows)


def walk_downstream(driver: Driver, start_keys: set[str], max_depth: int) -> Neo4jWalk:
    """The Postgres walk (knowledge_graph.walk_downstream) as Cypher, with the fingerprint of the
    chain Neo4j holds, read in the same transaction."""
    with driver.session(database=neo4j_database()) as session:
        return session.execute_read(_walk, sorted(start_keys), max_depth)
