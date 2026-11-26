from typing import Any

from pydantic import Field

from app.schemas.common import CamelCaseModel


class ChatIn(CamelCaseModel):
    """A chat turn: the conversation so far, ending with the user's question, and the browser's
    chat session. The browser demo also sends its own orders and playbook rules (`demo`), which
    the agents check (ai/server/orders.js); a company chat never uses them."""

    session_id: str = ""
    messages: list[Any] = Field(default_factory=list)
    demo: dict[str, Any] | None = None


class MemoryOut(CamelCaseModel):
    id: str
    fact: str
    updated_at: str | None = None


class MemoryListOut(CamelCaseModel):
    """What Memory Bank remembers about the caller; `keep_days` is how long it keeps each
    memory (None when unknown)."""

    memories: list[MemoryOut]
    enabled: bool
    keep_days: int | None = None


class MemoryDeletedOut(CamelCaseModel):
    deleted: bool
