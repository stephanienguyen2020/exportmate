"""News watch's records in Firestore, shared with the AI service's news scan (ai/server):
`sources` (one document per feed), `companySources/{companyId}` (the shared sources a
company switched off, `disabled`, and `skipOld` false when it switched the age rule off),
`impacts` (alerts), `articles` and `scans`, which the news scan (services/news_scan.py) writes,
`locks/scan` (one scan at a time), `companyGoods/{companyId}` (each company's goods, the demo
company's sample stock among them) and `rag_files` (the assistant's search records, core/rag_index.py).
The only place the backend reads or writes them; it never commits Postgres."""

from collections.abc import Callable
from functools import lru_cache
from typing import Protocol

from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

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
    def list_company_alerts(self, company_id: str) -> list[dict]: ...
    def get_latest_scan(self) -> dict | None: ...
    def get_company_goods(self, company_id: str) -> dict | None: ...
    def save_company_goods(self, company_id: str, fields: dict) -> None: ...
    def list_company_settings(self) -> dict[str, dict]: ...
    def list_goods_for_scan(self, limit: int) -> list[dict]: ...
    def find_analysed_articles(self, ids: list[str]) -> set[str]: ...
    def list_recent_articles(self, since: str, limit: int) -> list[dict]: ...
    def new_scan_id(self) -> str: ...
    def start_scan(self, fields: dict, scan_id: str | None = None) -> str: ...
    def update_scan(self, scan_id: str, fields: dict) -> None: ...
    def save_scan_results(self, articles: dict[str, dict], alerts: dict[str, dict]) -> None: ...
    def claim_scan_lock(self, claim: Callable[[dict | None], dict | None]) -> dict | None: ...
    def update_scan_lock(self, fields: dict) -> None: ...
    def get_rag_records(self, ids: list[str]) -> dict[str, dict]: ...
    def save_rag_records(self, records: dict[str, dict]) -> None: ...
    def list_rag_ids(self, doc_type: str) -> list[str]: ...
    def delete_rag_records(self, ids: list[str]) -> None: ...
    def list_scan_eval_runs(self, limit: int) -> list[dict]: ...
    def add_scan_eval_run(self, data: dict) -> str: ...


class FirestoreNewsStore:
    def __init__(self, project: str):
        self.client = firestore.Client(project=project)
        self.sources = self.client.collection("sources")
        self.company_sources = self.client.collection("companySources")
        self.impacts = self.client.collection("impacts")
        self.scans = self.client.collection("scans")
        self.company_goods = self.client.collection("companyGoods")
        self.articles = self.client.collection("articles")
        self.locks = self.client.collection("locks")
        self.rag_files = self.client.collection("rag_files")

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

    def list_company_alerts(self, company_id: str) -> list[dict]:
        # By companyId alone, which needs no composite index; the caller sorts.
        return _with_ids(
            self.impacts.where(filter=FieldFilter("companyId", "==", company_id)).stream()
        )

    def get_latest_scan(self) -> dict | None:
        query = self.scans.order_by("startedAt", direction=firestore.Query.DESCENDING)
        found = _with_ids(query.limit(1).stream())
        return found[0] if found else None

    def get_company_goods(self, company_id: str) -> dict | None:
        doc = self.company_goods.document(company_id).get()
        return doc.to_dict() if doc.exists else None

    def save_company_goods(self, company_id: str, fields: dict) -> None:
        self.company_goods.document(company_id).set(fields, merge=True)

    def list_company_settings(self) -> dict[str, dict]:
        return {d.id: d.to_dict() for d in self.company_sources.stream()}

    def list_goods_for_scan(self, limit: int) -> list[dict]:
        """Companies' goods, most recently refreshed first."""
        query = self.company_goods.order_by("updatedAt", direction=firestore.Query.DESCENDING)
        return _with_ids(query.limit(limit).stream())

    def find_analysed_articles(self, ids: list[str]) -> set[str]:
        found: set[str] = set()
        for start in range(0, len(ids), 100):
            refs = [self.articles.document(i) for i in ids[start : start + 100]]
            found |= {d.id for d in self.client.get_all(refs) if d.exists}
        return found

    def list_recent_articles(self, since: str, limit: int) -> list[dict]:
        query = (
            self.articles.where(filter=FieldFilter("publishedAt", ">=", since))
            .order_by("publishedAt", direction=firestore.Query.DESCENDING)
            .limit(limit)
        )
        return _with_ids(query.stream())

    def new_scan_id(self) -> str:
        return self.scans.document().id

    def start_scan(self, fields: dict, scan_id: str | None = None) -> str:
        ref = self.scans.document(scan_id) if scan_id else self.scans.document()
        ref.set(fields)
        return ref.id

    def update_scan(self, scan_id: str, fields: dict) -> None:
        self.scans.document(scan_id).update(fields)

    def save_scan_results(self, articles: dict[str, dict], alerts: dict[str, dict]) -> None:
        writes = [(self.articles.document(i), a) for i, a in articles.items()]
        writes += [(self.impacts.document(i), a) for i, a in alerts.items()]
        for start in range(0, len(writes), 400):
            batch = self.client.batch()
            for ref, data in writes[start : start + 400]:
                batch.set(ref, data)
            batch.commit()

    def claim_scan_lock(self, claim: Callable[[dict | None], dict | None]) -> dict | None:
        """Runs `claim` on the lock in a transaction: it returns the fields to set (the lock is
        then taken) or None (left as it is). Returns what was set."""
        ref = self.locks.document("scan")

        @firestore.transactional
        def take(transaction) -> dict | None:
            doc = ref.get(transaction=transaction)
            fields = claim(doc.to_dict() if doc.exists else None)
            if fields is not None:
                transaction.set(ref, fields)
            return fields

        return take(self.client.transaction())

    def update_scan_lock(self, fields: dict) -> None:
        self.locks.document("scan").set(fields, merge=True)

    def get_rag_records(self, ids: list[str]) -> dict[str, dict]:
        found: dict[str, dict] = {}
        for start in range(0, len(ids), 100):
            refs = [self.rag_files.document(i) for i in ids[start : start + 100]]
            found |= {d.id: d.to_dict() for d in self.client.get_all(refs) if d.exists}
        return found

    def save_rag_records(self, records: dict[str, dict]) -> None:
        items = list(records.items())
        for start in range(0, len(items), 400):
            batch = self.client.batch()
            for record_id, data in items[start : start + 400]:
                batch.set(self.rag_files.document(record_id), data)
            batch.commit()

    def list_rag_ids(self, doc_type: str) -> list[str]:
        query = self.rag_files.where(filter=FieldFilter("type", "==", doc_type)).select([])
        return [d.id for d in query.stream()]

    def delete_rag_records(self, ids: list[str]) -> None:
        for record_id in ids:
            self.rag_files.document(record_id).delete()

    def list_scan_eval_runs(self, limit: int) -> list[dict]:
        runs = self.client.collection("scan_eval_runs")
        query = runs.order_by("runAt", direction=firestore.Query.DESCENDING).limit(limit)
        return _with_ids(query.stream())

    def add_scan_eval_run(self, data: dict) -> str:
        _, ref = self.client.collection("scan_eval_runs").add(data)
        return ref.id


def _with_ids(docs) -> list[dict]:
    return [{"id": d.id, **d.to_dict()} for d in docs]


@lru_cache
def get_news_store() -> NewsStore:
    project = get_settings().google_cloud_project
    if not project:
        raise AppError(
            503, "news_not_configured", "News watch is not set up (GOOGLE_CLOUD_PROJECT)."
        )
    return FirestoreNewsStore(project)
