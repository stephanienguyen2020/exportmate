from typing import Annotated

from fastapi import APIRouter, Depends, Header, Response
from sqlalchemy.orm import Session

from app.database.session import get_db
from app.schemas.graph_sync import PubSubPushIn
from app.services import graph_events

router = APIRouter(prefix="/internal", tags=["internal"])
Db = Annotated[Session, Depends(get_db)]


@router.post("/graph-sync", status_code=204, include_in_schema=False)
def sync_graph_change(
    payload: PubSubPushIn, db: Db, authorization: Annotated[str | None, Header()] = None
):
    """Pub/Sub's push subscription to graph change events: syncs the change into Neo4j. Only
    with an OIDC token for GRAPH_SYNC_AUDIENCE signed as GRAPH_SYNC_INVOKER (404 when unset)."""
    graph_events.verify_push_token(authorization)
    graph_events.sync_pushed_change(db, payload.message.data)
    return Response(status_code=204)
