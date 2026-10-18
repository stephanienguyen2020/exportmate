"""The Neo4j driver for the knowledge graph's read model (AuraDB), or None when NEO4J_URI isn't
set. Callers fall back to Postgres whenever Neo4j can't answer (services/graph_store.py)."""

import logging
from functools import lru_cache

from neo4j import Driver, GraphDatabase, NotificationMinimumSeverity

from app.core.config import get_settings

log = logging.getLogger(__name__)

CONNECTION_TIMEOUT_SECONDS = 5  # AuraDB Free pauses when idle; don't hold a request for it
RETRY_SECONDS = 5


@lru_cache
def get_neo4j_driver() -> Driver | None:
    settings = get_settings()
    if not settings.neo4j_uri:
        return None
    log.info("neo4j.driver_created", extra={"neo4j_uri": settings.neo4j_uri})
    return GraphDatabase.driver(
        settings.neo4j_uri,
        auth=(settings.neo4j_username, settings.neo4j_password),
        connection_timeout=CONNECTION_TIMEOUT_SECONDS,
        connection_acquisition_timeout=CONNECTION_TIMEOUT_SECONDS,
        max_transaction_retry_time=RETRY_SECONDS,
        # Not its notes on our queries ("constraint already exists") in our logs.
        notifications_min_severity=NotificationMinimumSeverity.OFF,
    )


def neo4j_database() -> str:
    return get_settings().neo4j_database
