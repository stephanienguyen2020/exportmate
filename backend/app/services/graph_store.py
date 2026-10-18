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
    """One request's walks: the Postgres fingerprint is read once, and each walk's answer kept."""

    def __init__(self, db: Session):
        self.db = db
        self._fingerprint: str | None = None
        self._walks: dict[tuple[frozenset[str], int], list[GraphWalkRow]] = {}
        self.answered_by: set[str] = set()  # "neo4j", "postgres"

    def _postgres_fingerprint(self) -> str:
        if self._fingerprint is None:
            self._fingerprint = graph_queries.chain_fingerprint(self.db)
        return self._fingerprint

    def walk_downstream(self, start_keys: set[str], max_depth: int) -> list[GraphWalkRow]:
        key = (frozenset(start_keys), max_depth)
        if key not in self._walks:
            self._walks[key] = self._walk(start_keys, max_depth) if start_keys else []
        return self._walks[key]

    def _walk(self, start_keys: set[str], max_depth: int) -> list[GraphWalkRow]:
        global _neo4j_skipped_until
        driver = get_neo4j_driver()
        if driver is not None and time.monotonic() >= _neo4j_skipped_until:
            try:
                walk = neo4j_graph.walk_downstream(driver, start_keys, max_depth)
            except (Neo4jError, DriverError, OSError) as error:
                _neo4j_skipped_until = time.monotonic() + SKIP_AFTER_FAILURE_SECONDS
                log.warning("graph.neo4j_unavailable", extra={"error": type(error).__name__})
            else:
                if walk.fingerprint == self._postgres_fingerprint():
                    self.answered_by.add("neo4j")
                    return walk.rows
                log.warning("graph.neo4j_stale")
        self.answered_by.add("postgres")
        return graph_queries.walk_downstream(self.db, start_keys, max_depth)
