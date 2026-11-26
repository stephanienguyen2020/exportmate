"""News watch's records in Firestore, shared with the AI service's news scan (ai/server):
`sources` (one document per feed) and `companySources/{companyId}` (the shared sources a
company switched off, `disabled`, and `skipOld` false when it switched the age rule off).
The only place the backend reads or writes them; it never commits Postgres."""

from functools import lru_cache
from typing import Protocol

from google.cloud import firestore

from app.core.config import get_settings
from app.core.errors import AppError


class NewsStore(Protocol):
    def list_sources(self) -> list[dict]: ...
    def get_source(self, source_id: str) -> dict | None: ...
    def add_source(self, data: dict) -> str: ...
    def update_source(self, source_id: str, fields: dict) -> None: ...
    def delete_source(self, source_id: str) -> None: ...
    def get_company_settings(self, company_id: str) -> dict: ...
    def set_source_disabled(
        self, company_id: str, source_id: str, disabled: bool, fields: dict
    ) -> None: ...
    def update_company_settings(self, company_id: str, fields: dict) -> None: ...


class FirestoreNewsStore:
    def __init__(self, project: str):
        self.client = firestore.Client(project=project)
        self.sources = self.client.collection("sources")
        self.company_sources = self.client.collection("companySources")

    def list_sources(self) -> list[dict]:
        return [{"id": d.id, **d.to_dict()} for d in self.sources.order_by("name").stream()]

    def get_source(self, source_id: str) -> dict | None:
        doc = self.sources.document(source_id).get()
        return {"id": doc.id, **doc.to_dict()} if doc.exists else None

    def add_source(self, data: dict) -> str:
        _, ref = self.sources.add(data)
        return ref.id

    def update_source(self, source_id: str, fields: dict) -> None:
        self.sources.document(source_id).update(fields)

    def delete_source(self, source_id: str) -> None:
        self.sources.document(source_id).delete()

    def get_company_settings(self, company_id: str) -> dict:
        doc = self.company_sources.document(company_id).get()
        return doc.to_dict() if doc.exists else {}

    def set_source_disabled(
        self, company_id: str, source_id: str, disabled: bool, fields: dict
    ) -> None:
        change = (
            firestore.ArrayUnion([source_id]) if disabled else firestore.ArrayRemove([source_id])
        )
        self.company_sources.document(company_id).set({"disabled": change, **fields}, merge=True)

    def update_company_settings(self, company_id: str, fields: dict) -> None:
        self.company_sources.document(company_id).set(fields, merge=True)


@lru_cache
def get_news_store() -> NewsStore:
    project = get_settings().google_cloud_project
    if not project:
        raise AppError(
            503, "news_not_configured", "News watch is not set up (GOOGLE_CLOUD_PROJECT)."
        )
    return FirestoreNewsStore(project)
