"""The assistant's audit records in Firestore `audits`: one per answer, written by the agents
(ai/server/agent.js) with every step, citation and check. The backend only reads them."""

from functools import lru_cache
from typing import Protocol

from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from app.core.config import get_settings
from app.core.errors import AppError

# Audits one chat session may list.
MAX_SESSION_AUDITS = 100


class AssistantStore(Protocol):
    def list_session_audits(self, session_id: str) -> list[dict]: ...
    def get_audit(self, audit_id: str) -> dict | None: ...


class FirestoreAssistantStore:
    def __init__(self, project: str):
        self.audits = firestore.Client(project=project).collection("audits")

    def list_session_audits(self, session_id: str) -> list[dict]:
        query = self.audits.where(filter=FieldFilter("sessionId", "==", session_id))
        return [{"id": d.id, **d.to_dict()} for d in query.limit(MAX_SESSION_AUDITS).stream()]

    def get_audit(self, audit_id: str) -> dict | None:
        doc = self.audits.document(audit_id).get()
        return {"id": doc.id, **doc.to_dict()} if doc.exists else None


@lru_cache
def get_assistant_store() -> AssistantStore:
    project = get_settings().google_cloud_project
    if not project:
        raise AppError(
            503, "assistant_not_configured", "The assistant is not set up (GOOGLE_CLOUD_PROJECT)."
        )
    return FirestoreAssistantStore(project)
