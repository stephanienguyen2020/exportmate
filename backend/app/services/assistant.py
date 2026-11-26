"""The assistant's chat, audits and memories (moved from the AI service's /api/chat,
/api/audits and /api/memories). The agents themselves run on Agent Runtime
(ai/server/runtime.js, reached through core/agents.py); this service passes each turn to them
with what the caller may see, streams their events back and logs one line per answer.

A company chat carries the company profile and sites, its news access and the member's own
token, which the agents use to read the company's orders and playbook from this API; the
token is never stored. A signed-out chat is the browser demo: the demo company's news access
and the orders and rules the browser sent, which the agents check before reading."""

import json
import logging
import re
from collections.abc import Iterator

from sqlalchemy.orm import Session

from app.core.agents import AgentsError, get_agents
from app.core.config import get_settings
from app.core.context import CompanyContext
from app.core.errors import AppError, not_found_error
from app.core.rate_limit import RateLimiter
from app.database.assistant_store import get_assistant_store
from app.schemas.assistant import ChatIn, MemoryDeletedOut, MemoryListOut
from app.services.accounts import build_company_knowledge
from app.services.news_sources import news_access

SESSION = re.compile(r"^[A-Za-z0-9-]{8,64}$")
MEMORY_ID = re.compile(r"^\d{1,30}$")
MAX_MESSAGES = 20
MAX_CHARS = 4000
MAX_SOURCES = 12
MAX_SOURCE_CHARS = 200
UNAVAILABLE = "The assistant is unavailable right now."

_per_client = RateLimiter("questions")
_per_instance = RateLimiter("questions to the assistant here")

log = logging.getLogger(__name__)


def parse_messages(raw: list) -> list[dict] | None:
    """The last MAX_MESSAGES turns, each {role, text, sources?} trimmed to size; None unless the
    conversation starts and ends with the user."""
    parsed = []
    for m in raw[-MAX_MESSAGES:]:
        if not (
            isinstance(m, dict)
            and isinstance(m.get("text"), str)
            and m.get("role") in ("user", "model")
        ):
            return None
        message = {"role": m["role"], "text": m["text"][:MAX_CHARS]}
        if isinstance(m.get("sources"), list):
            message["sources"] = [s[:MAX_SOURCE_CHARS] for s in m["sources"] if isinstance(s, str)][
                :MAX_SOURCES
            ]
        parsed.append(message)
    if not parsed or parsed[0]["role"] != "user" or parsed[-1]["role"] != "user":
        return None
    return parsed


def start_chat(
    db: Session,
    ctx: CompanyContext | None,
    token: str | None,
    payload: ChatIn,
    client: str,
    request_id: str,
) -> Iterator[bytes]:
    """Checks the turn and the limits, then returns its events as NDJSON lines."""
    messages = parse_messages(payload.messages)
    if not messages:
        raise AppError(400, "invalid_chat", "Expected messages ending with a user message.")
    if not SESSION.match(payload.session_id):
        raise AppError(400, "invalid_chat", "Expected a sessionId.")
    agents = get_agents()
    settings = get_settings()
    _per_instance.check("all", settings.chat_limit_per_instance)
    _per_client.check(client, settings.chat_limit_per_client)

    access = news_access(ctx)
    turn = {
        "messages": messages,
        "sessionId": payload.session_id,
        "requestId": request_id,
        "access": {
            "companyId": access.company_id,
            "disabled": access.disabled,
            **({"skipOld": False} if access.skip_old_off else {}),
        },
    }
    if ctx:
        knowledge = build_company_knowledge(db, ctx)
        turn["company"] = knowledge.model_dump(mode="json", by_alias=True)
        turn["user"] = {"id": str(ctx.user.id)}
        turn["backendToken"] = token
    else:
        turn["demo"] = payload.demo
    return _events(agents, turn)


def _events(agents, turn: dict) -> Iterator[bytes]:
    try:
        for event in agents.stream_turn(turn):
            yield (json.dumps(event, ensure_ascii=False) + "\n").encode()
            if event.get("type") == "done":
                _log_chat(event.get("audit") or {})
            elif event.get("type") == "error":
                log.error("chat.agents_error", extra={"auditId": event.get("auditId")})
    except (AgentsError, ValueError) as error:
        log.error("chat.failed", extra={"error": str(error)[:300]})
        yield (json.dumps({"type": "error", "error": UNAVAILABLE}) + "\n").encode()


def _log_chat(audit: dict) -> None:
    """One line per answer for Cloud Logging's chat metrics (infra/terraform/ai_service.tf):
    outcome, latency, tokens, tool errors, the auditor's result. Never the question or answer."""
    steps = audit.get("steps") or []
    tools = [s for s in steps if s.get("kind") == "tool"]
    usage = audit.get("usage") or {}
    route = audit.get("route") or {}
    critic = audit.get("critic")
    log.log(
        logging.ERROR if audit.get("status") == "error" else logging.INFO,
        "chat.completed",
        extra={
            "auditId": audit.get("id"),
            "companyId": audit.get("companyId"),
            "status": audit.get("status"),
            "policyVersion": audit.get("policyVersion"),
            "model": audit.get("model"),
            "tier": route.get("tier"),
            "escalated": bool(route.get("escalated")),
            "cached": bool(audit.get("cache")),
            "latencyMs": audit.get("latencyMs"),
            "modelCalls": usage.get("modelCalls"),
            "promptTokens": usage.get("promptTokens"),
            "outputTokens": usage.get("outputTokens"),
            "toolCalls": len(tools),
            "toolErrors": [
                f"{s.get('name')}:{s.get('errorKind')}" for s in tools if s.get("error")
            ],
            "revised": any(s.get("kind") == "review" for s in steps),
            "checksFailed": [c.get("name") for c in audit.get("checks") or [] if not c.get("ok")],
            "citations": len(audit.get("citations") or []),
            "withheld": len(audit.get("flags") or []),
            **(
                {
                    "criticMs": critic.get("latencyMs"),
                    "criticThinkingTokens": (critic.get("tokens") or {}).get("thinking"),
                    "criticAttempts": critic.get("attempts") or 1,
                    "criticError": critic.get("error"),
                }
                if isinstance(critic, dict)
                else {}
            ),
        },
    )


def public_audit(audit: dict) -> dict:
    """The model's raw reasoning (`thought`) stays in the stored audit for reviewers."""
    steps = [{k: v for k, v in s.items() if k != "thought"} for s in audit.get("steps") or []]
    return {**audit, "steps": steps}


def list_session_audits(ctx: CompanyContext | None, session_id: str) -> list[dict]:
    """A chat session's audits, oldest first. Anyone with the session id reads a demo chat's;
    a company chat's also need a member of that company."""
    if not SESSION.match(session_id):
        raise AppError(400, "invalid_session", "Expected ?session=.")
    company_id = str(ctx.company_id) if ctx else None
    audits = get_assistant_store().list_session_audits(session_id)
    visible = [a for a in audits if not a.get("companyId") or a["companyId"] == company_id]
    return [public_audit(a) for a in sorted(visible, key=lambda a: str(a.get("createdAt", "")))]


def _user_key(ctx: CompanyContext) -> str:
    """Who Memory Bank remembers: the member within their company (ai/server/agents/platform.js)."""
    return f"{ctx.company_id}:{ctx.user.id}"


def list_memories(ctx: CompanyContext) -> MemoryListOut:
    if not get_settings().agent_runtime:
        return MemoryListOut(memories=[], enabled=False)
    agents = get_agents()
    try:
        memories = agents.call("list_memories", {"userKey": _user_key(ctx)}).get("memories") or []
    except AgentsError as error:
        log.error("memory.unavailable", extra={"error": str(error)[:300]})
        raise AppError(502, "assistant_unavailable", UNAVAILABLE) from error
    return MemoryListOut.model_validate(
        {"memories": memories, "enabled": True, "keepDays": agents.memory_keep_days()}
    )


def delete_memory(ctx: CompanyContext, memory_id: str) -> MemoryDeletedOut:
    """Forgets one of the caller's memories; one that isn't theirs answers like a missing one."""
    if not MEMORY_ID.match(memory_id) or not get_settings().agent_runtime:
        raise not_found_error("Memory")
    try:
        deleted = (
            get_agents()
            .call("delete_memory", {"userKey": _user_key(ctx), "id": memory_id})
            .get("deleted")
        )
    except AgentsError as error:
        log.error("memory.unavailable", extra={"error": str(error)[:300]})
        raise AppError(502, "assistant_unavailable", UNAVAILABLE) from error
    if not deleted:
        raise not_found_error("Memory")
    log.info("memory.deleted")
    return MemoryDeletedOut(deleted=True)
