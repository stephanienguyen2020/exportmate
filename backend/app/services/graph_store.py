"""Where the knowledge graph walk runs: Cypher on Neo4j, the read model, when it is configured,
reachable and holds the chain Postgres holds (same fingerprint); otherwise the recursive SQL
walk on Postgres. Both give the same rows, so the walker (knowledge_graph.py) doesn't care which
answered. After Neo4j fails, it is left alone for a minute so requests don't each wait on it."""

import logging
import time

from neo4j.exceptions import DriverError, Neo4jError
from sqlalchemy.orm import Session

from app.core.neo4j import get_neo4j_driver
from app.database.queries import knowledge_graph as graph_queries
from app.database.queries import neo4j_graph
from app.database.queries.knowledge_graph import GraphWalkRow

log = logging.getLogger(__name__)

SKIP_AFTER_FAILURE_SECONDS = 60
_neo4j_skipped_until = 0.0


class GraphStore:
    """One request's walks. Neo4j is asked once, for the walk from every node (the graph is
    small: about 300 rows), and each walk is then read from that, so a request pays Neo4j's
    round trips once however many walks it makes (News watch makes one per alert)."""

    def __init__(self, db: Session):
        self.db = db
        self._from_neo4j: dict[str, list[GraphWalkRow]] | None = None
        self._neo4j_asked = False
        self.answered_by: set[str] = set()  # "neo4j", "postgres"

    def walk_downstream(self, start_keys: set[str], max_depth: int) -> list[GraphWalkRow]:
        if not start_keys:
            return []
        walked = self._neo4j_walk(max_depth)
        if walked is not None:
            self.answered_by.add("neo4j")
            return [row for key in sorted(start_keys) for row in walked.get(key, [])]
        self.answered_by.add("postgres")
        return graph_queries.walk_downstream(self.db, start_keys, max_depth)

    def _neo4j_walk(self, max_depth: int) -> dict[str, list[GraphWalkRow]] | None:
        """The walk from every node, by start; None when Neo4j can't be trusted to answer."""
        global _neo4j_skipped_until
        if self._neo4j_asked:
            return self._from_neo4j
        self._neo4j_asked = True
        driver = get_neo4j_driver()
        if driver is None or time.monotonic() < _neo4j_skipped_until:
            return None
        keys = {node.key for node in graph_queries.list_graph_nodes(self.db)}
        try:
            walk = neo4j_graph.walk_downstream(driver, keys, max_depth)
        except (Neo4jError, DriverError, OSError) as error:
            _neo4j_skipped_until = time.monotonic() + SKIP_AFTER_FAILURE_SECONDS
            log.warning("graph.neo4j_unavailable", extra={"error": type(error).__name__})
            return None
        if walk.fingerprint != graph_queries.chain_fingerprint(self.db):
            log.warning("graph.neo4j_stale")
            return None
        self._from_neo4j = {}
        for row in walk.rows:
            self._from_neo4j.setdefault(row.start_key, []).append(row)
        return self._from_neo4j
