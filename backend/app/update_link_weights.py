"""The nightly link weights job: counts every company's News watch verdicts per chain link into
graph_link_weights, with each link's weight (services/graph_feedback.py). Walks read it for links
doubted across companies and to prefer, between equally good paths, the one people confirm more.

Then a full sync into Neo4j (services/graph_sync.py), which catches up any change event lost.

Run by Cloud Scheduler through the Cloud Run job exportmate-backend-link-weights
(infra/terraform/backend_service.tf); locally: uv run python -m app.update_link_weights
"""

import logging

from app.core.config import get_settings
from app.core.logging import configure_logging
from app.database.queries import knowledge_graph as graph_queries
from app.database.session import open_session
from app.services import graph_sync
from app.services.graph_feedback import count_link_weights

logger = logging.getLogger(__name__)


def update_link_weights() -> int:
    with open_session() as db:
        rows = count_link_weights(db)
        graph_queries.replace_link_weights(db, rows)
        db.commit()
    judged = sum(1 for r in rows if r["confirmed"] or r["rejected"])
    logger.info("graph.link_weights_updated", extra={"links": len(rows), "judged": judged})
    return len(rows)


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, settings.resolved_log_format)
    print(f"Link weights: {update_link_weights()} links counted")
    # Then Neo4j, all of it: the new weights, and whatever change events were lost.
    with open_session() as db:
        synced = graph_sync.sync_all(db)
    print(f"Neo4j: {synced or 'not configured'}")


if __name__ == "__main__":
    main()
