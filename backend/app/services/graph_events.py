"""What happens to a graph change after a commit (database/graph_changes.py).

With GRAPH_EVENTS_TOPIC (Cloud Run) the change is published to Pub/Sub, whose push subscription
calls POST /internal/graph-sync with an OIDC token; that request syncs it into Neo4j and a failed
sync is retried by Pub/Sub. Without a topic but with Neo4j (local runs) it is synced on one
background thread, in commit order. With neither, nothing happens. A change that is lost is
caught up by the nightly full sync (app/update_link_weights.py).
"""

import base64
import json
import logging
import uuid
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import google.auth
from google.auth.transport.requests import AuthorizedSession, Request
from google.oauth2 import id_token
from neo4j.exceptions import DriverError, Neo4jError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.errors import AppError
from app.database.graph_changes import GraphChange, set_change_handler
from app.database.session import open_session
from app.services import graph_sync

log = logging.getLogger(__name__)

PUBSUB_SCOPE = "https://www.googleapis.com/auth/pubsub"
PUBLISH_TIMEOUT_SECONDS = 5
_local_sync = ThreadPoolExecutor(max_workers=1, thread_name_prefix="graph-sync")


def change_to_message(change: GraphChange) -> dict:
    return {
        "chain": change.chain,
        "companyIds": sorted(str(c) for c in change.company_ids),
        "supplierIds": sorted(str(s) for s in change.supplier_ids),
        "everyCompany": change.every_company,
    }


def change_from_message(message: dict) -> GraphChange:
    return GraphChange(
        chain=bool(message.get("chain")),
        company_ids={uuid.UUID(c) for c in message.get("companyIds", [])},
        supplier_ids={uuid.UUID(s) for s in message.get("supplierIds", [])},
        every_company=bool(message.get("everyCompany")),
    )


@lru_cache
def _pubsub_session() -> AuthorizedSession:
    credentials, _ = google.auth.default(scopes=[PUBSUB_SCOPE])
    return AuthorizedSession(credentials)


def _publish(topic: str, change: GraphChange) -> None:
    data = base64.b64encode(json.dumps(change_to_message(change)).encode()).decode()
    response = _pubsub_session().post(
        f"https://pubsub.googleapis.com/v1/{topic}:publish",
        json={"messages": [{"data": data}]},
        timeout=PUBLISH_TIMEOUT_SECONDS,
    )
    response.raise_for_status()


def _sync_here(change: GraphChange) -> None:
    try:
        with open_session() as db:
            graph_sync.sync_change(db, change)
    except Exception:
        log.exception("graph.sync_failed")


def on_commit(change: GraphChange) -> None:
    settings = get_settings()
    if settings.graph_events_topic:
        # Published before the request ends: Cloud Run may pause a thread left running after.
        _publish(settings.graph_events_topic, change)
    elif settings.neo4j_uri:
        _local_sync.submit(_sync_here, change)


def install() -> None:
    """Hands every commit's graph change to `on_commit` (the API and the jobs that write)."""
    set_change_handler(on_commit)


# --- The push subscription's request


def verify_push_token(authorization: str | None) -> None:
    settings = get_settings()
    if not (settings.graph_sync_audience and settings.graph_sync_invoker):
        raise AppError(404, "not_found", "Not found.")
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise AppError(401, "unauthenticated", "A Pub/Sub OIDC token is required.")
    try:
        claims = id_token.verify_oauth2_token(token, Request(), settings.graph_sync_audience)
    except ValueError as error:
        raise AppError(401, "invalid_token", "The Pub/Sub token isn't valid.") from error
    if claims.get("email") != settings.graph_sync_invoker or not claims.get("email_verified"):
        raise AppError(403, "not_graph_sync_invoker", "Only the Pub/Sub push account may sync.")


def sync_pushed_change(db: Session, data: str) -> None:
    """Syncs one pushed change; a failure answers 503 so Pub/Sub delivers it again."""
    try:
        change = change_from_message(json.loads(base64.b64decode(data)))
    except (ValueError, TypeError) as error:
        # Acknowledged (not retried): it would fail the same way every time.
        log.warning("graph.change_unreadable", extra={"error": type(error).__name__})
        return
    try:
        graph_sync.sync_change(db, change)
    except (Neo4jError, DriverError, OSError) as error:
        log.warning("graph.sync_failed", extra={"error": type(error).__name__})
        raise AppError(503, "graph_sync_failed", "Neo4j couldn't be updated.") from error
