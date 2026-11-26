from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.core.auth import OptionalContext, ViewerContext
from app.core.request_context import current_request_id, visitor_address
from app.database.session import get_db
from app.schemas.assistant import ChatIn, MemoryDeletedOut, MemoryListOut
from app.schemas.common import SuccessResponse, success_response
from app.services import assistant as assistant_service

router = APIRouter(prefix="/assistant", tags=["assistant"])
Db = Annotated[Session, Depends(get_db)]


@router.post("/chat")
def chat(
    payload: ChatIn,
    ctx: OptionalContext,
    db: Db,
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
):
    """One assistant turn, streamed as NDJSON: `step` events as the agents work, then `done`
    (reply, citations, audit) or `error`. Signed out, it is the browser demo's chat."""
    token = (authorization or "").partition(" ")[2] if ctx else None
    events = assistant_service.start_chat(
        db, ctx, token, payload, visitor_address(request), current_request_id() or ""
    )
    return StreamingResponse(
        events,
        media_type="application/x-ndjson; charset=utf-8",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@router.get("/audits", response_model=SuccessResponse[list[dict]])
def list_audits(ctx: OptionalContext, session: Annotated[str, Query()] = ""):
    """The audit of every answer in a chat session (steps, citations, checks), oldest first."""
    return success_response(assistant_service.list_session_audits(ctx, session))


@router.get("/memories", response_model=SuccessResponse[MemoryListOut])
def list_memories(ctx: ViewerContext):
    """What the assistant remembers about the caller (Account › What the assistant remembers)."""
    return success_response(assistant_service.list_memories(ctx))


@router.delete("/memories/{memory_id}", response_model=SuccessResponse[MemoryDeletedOut])
def delete_memory(memory_id: str, ctx: ViewerContext):
    return success_response(assistant_service.delete_memory(ctx, memory_id))
