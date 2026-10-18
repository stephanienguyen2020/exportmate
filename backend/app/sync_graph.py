"""Copies the whole knowledge graph from Postgres into Neo4j (services/graph_sync.py): the chain
and every company's suppliers and orders. Run by deploy.sh after the reference seed, and by hand
after loading data with the event handler off (the seeds):

    uv run python -m app.sync_graph
"""

from app.core.config import get_settings
from app.core.logging import configure_logging
from app.database.session import open_session
from app.services import graph_sync


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, settings.resolved_log_format)
    with open_session() as db:
        synced = graph_sync.sync_all(db)
    print(f"Neo4j: {synced}" if synced else "Neo4j: not configured (NEO4J_URI), nothing synced")


if __name__ == "__main__":
    main()
