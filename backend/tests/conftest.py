"""Tests run against a real Postgres database (TEST_DATABASE_URL), migrated with Alembic.

Never point TEST_DATABASE_URL at a database you care about: its schema is dropped each run.
"""

import hashlib
import math
import os
import re
from collections.abc import Iterator
from datetime import date
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import text

from app import seed_reference_data
from app.core import clock, gemini
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.neo4j import get_neo4j_driver
from app.database.models import Base, Role
from app.database.queries import users as user_queries
from app.database.session import get_engine, open_session
from app.main import create_app
from app.services import market_requirements as requirement_service
from app.services import news_alerts as news_alert_service
from app.services import news_goods as news_goods_service
from app.services import news_scan as news_scan_service
from app.services import news_scan_runs
from app.services import news_sources as news_source_service
from app.services import regulations as regulation_service
from app.services import supplier_documents as supplier_document_service
from app.services import suppliers as supplier_service

BACKEND_DIR = Path(__file__).resolve().parent.parent

VALID_CSV = (
    "id,product,supplier,destination,value,shipDate,hsCode\n"
    'PO-1,Acacia plywood 18 mm,Binh Phu Wood,"Rotterdam, NL",24000,2026-10-27,4412.33\n'
    'PO-2,Milk powder,Dairy Co,"Singapore, SG",19.99,2026-11-02,0401.10\n'
)


@pytest.fixture(scope="session", autouse=True)
def test_database() -> Iterator[None]:
    # TEST_DATABASE_URL comes from the environment or backend/.env.
    os.environ["DATABASE_URL"] = get_settings().test_database_url
    os.environ["AUTH_MODE"] = "dev"
    os.environ["ENV"] = "test"
    # Never the Neo4j or Pub/Sub topic in backend/.env: tests walk and change Postgres only.
    os.environ["NEO4J_URI"] = ""
    os.environ["GRAPH_EVENTS_TOPIC"] = ""
    get_settings.cache_clear()
    get_neo4j_driver.cache_clear()
    get_engine.cache_clear()

    with get_engine().begin() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"))
    alembic_config = Config(str(BACKEND_DIR / "alembic.ini"))
    alembic_config.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    alembic_config.attributes["database_url"] = os.environ["DATABASE_URL"]
    command.upgrade(alembic_config, "head")
    yield
    get_engine().dispose()


@pytest.fixture(autouse=True)
def empty_tables() -> Iterator[None]:
    yield
    tables = ", ".join(t.name for t in Base.metadata.sorted_tables)
    with get_engine().begin() as conn:
        conn.execute(text(f"TRUNCATE {tables} CASCADE"))


class InMemoryFileStorage:
    """Stands in for Cloud Storage so tests never touch the real bucket."""

    def __init__(self):
        self.files: dict[str, bytes] = {}

    def save_file(self, path: str, content: bytes, content_type: str) -> None:
        self.files[path] = content

    def load_file(self, path: str) -> bytes:
        return self.files[path]

    def delete_file(self, path: str) -> None:
        del self.files[path]


# Every module that saves or reads files in Cloud Storage.
FILE_STORAGE_USERS = [
    regulation_service,
    requirement_service,
    supplier_document_service,
    supplier_service,
]


@pytest.fixture(autouse=True)
def file_storage(monkeypatch: pytest.MonkeyPatch) -> InMemoryFileStorage:
    storage = InMemoryFileStorage()
    for module in FILE_STORAGE_USERS:
        monkeypatch.setattr(module, "get_file_storage", lambda: storage)
    return storage


class InMemoryNewsStore:
    """News watch's Firestore records (app/database/news_store.py) in memory."""

    def __init__(self):
        self.sources: dict[str, dict] = {}
        self.companies: dict[str, dict] = {}
        self.alerts: dict[str, dict] = {}
        self.scans: list[dict] = []
        self.goods: dict[str, dict] = {}
        self.articles: dict[str, dict] = {}
        self.scan_records: dict[str, dict] = {}
        self.lock: dict | None = None
        self.rag: dict[str, dict] = {}

    def list_sources(self) -> list[dict]:
        return sorted(
            ({"id": i, **s} for i, s in self.sources.items()), key=lambda s: s.get("name", "")
        )

    def get_source(self, source_id: str) -> dict | None:
        found = self.sources.get(source_id)
        return {"id": source_id, **found} if found else None

    def add_source(self, data: dict) -> str:
        source_id = f"src{len(self.sources) + 1}"
        self.sources[source_id] = dict(data)
        return source_id

    def update_source(self, source_id: str, fields: dict) -> None:
        self.sources[source_id].update(fields)

    def delete_source(self, source_id: str) -> None:
        del self.sources[source_id]

    def get_company_settings(self, company_id: str) -> dict:
        return dict(self.companies.get(company_id, {}))

    def set_source_disabled(
        self, company_id: str, source_id: str, disabled: bool, fields: dict
    ) -> None:
        company = self.companies.setdefault(company_id, {})
        ids = [i for i in company.get("disabled", []) if i != source_id]
        company.update(fields, disabled=ids + ([source_id] if disabled else []))

    def update_company_settings(self, company_id: str, fields: dict) -> None:
        self.companies.setdefault(company_id, {}).update(fields)

    def list_company_alerts(self, company_id: str) -> list[dict]:
        return [{"id": i, **a} for i, a in self.alerts.items() if a.get("companyId") == company_id]

    def get_latest_scan(self) -> dict | None:
        return max(self.scans, key=lambda s: s["startedAt"], default=None)

    def get_company_goods(self, company_id: str) -> dict | None:
        found = self.goods.get(company_id)
        return dict(found) if found else None

    def save_company_goods(self, company_id: str, fields: dict) -> None:
        self.goods.setdefault(company_id, {}).update(fields)

    def list_company_settings(self) -> dict[str, dict]:
        return {i: dict(c) for i, c in self.companies.items()}

    def list_goods_for_scan(self, limit: int) -> list[dict]:
        goods = ({"id": i, **g} for i, g in self.goods.items())
        return sorted(goods, key=lambda g: g.get("updatedAt", ""), reverse=True)[:limit]

    def find_analysed_articles(self, ids: list[str]) -> set[str]:
        return set(ids) & set(self.articles)

    def list_recent_articles(self, since: str, limit: int) -> list[dict]:
        recent = [
            {"id": i, **a} for i, a in self.articles.items() if a.get("publishedAt", "") >= since
        ]
        return sorted(recent, key=lambda a: a["publishedAt"], reverse=True)[:limit]

    def new_scan_id(self) -> str:
        return f"scan{len(self.scan_records) + 1}"

    def start_scan(self, fields: dict, scan_id: str | None = None) -> str:
        scan_id = scan_id or self.new_scan_id()
        self.scan_records[scan_id] = dict(fields)
        self.scans = [{"id": i, **r} for i, r in self.scan_records.items()]
        return scan_id

    def update_scan(self, scan_id: str, fields: dict) -> None:
        self.scan_records[scan_id].update(fields)
        self.scans = [{"id": i, **r} for i, r in self.scan_records.items()]

    def save_scan_results(self, articles: dict[str, dict], alerts: dict[str, dict]) -> None:
        self.articles.update(articles)
        self.alerts.update(alerts)

    def claim_scan_lock(self, claim):
        fields = claim(dict(self.lock) if self.lock else None)
        if fields is not None:
            self.lock = dict(fields)
        return fields

    def update_scan_lock(self, fields: dict) -> None:
        self.lock = {**(self.lock or {}), **fields}

    def get_rag_records(self, ids: list[str]) -> dict[str, dict]:
        return {i: dict(self.rag[i]) for i in ids if i in self.rag}

    def save_rag_records(self, records: dict[str, dict]) -> None:
        self.rag.update(records)

    def list_rag_ids(self, doc_type: str) -> list[str]:
        return [i for i, r in self.rag.items() if r.get("type") == doc_type]

    def delete_rag_records(self, ids: list[str]) -> None:
        for record_id in ids:
            self.rag.pop(record_id, None)


@pytest.fixture(autouse=True)
def news_store(monkeypatch: pytest.MonkeyPatch) -> InMemoryNewsStore:
    store = InMemoryNewsStore()
    services = (
        news_source_service,
        news_alert_service,
        news_goods_service,
        news_scan_service,
        news_scan_runs,
    )
    for service in services:
        monkeypatch.setattr(service, "get_news_store", lambda: store)
    return store


def fake_official_text(url: str, accept: str | None) -> bytes:
    """A small, distinct file per URL, so the seed never downloads real law texts in tests.
    Only .pdf files are checked for content, so a PDF header suits every source."""
    return f"%PDF-1.7 official text from {url}".encode()


@pytest.fixture(autouse=True)
def official_texts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(seed_reference_data, "fetch_official_text", fake_official_text)


def word_vector(text: str) -> list[float]:
    """A stand-in embedding: each word (and its 4-letter stem) bumps one of 768 dimensions, so
    texts that share words point the same way. Good enough to test nearest-neighbour search."""
    vector = [0.0] * gemini.EMBEDDING_DIMENSIONS
    for word in re.findall(r"[a-z]{3,}", text.lower()):
        for token in {word, word[:4]}:
            index = int(hashlib.md5(token.encode()).hexdigest(), 16) % len(vector)
            vector[index] += 1.0
    norm = math.sqrt(sum(x * x for x in vector)) or 1.0
    return [x / norm for x in vector]


class FakeGemini:
    """Stands in for Gemini. Tests set `answers[task]` to a function of (prompt, file) that
    returns the schema's object; a task with no answer fails like an unreachable model.
    Embeddings are word vectors unless `embeddings_fail` is set."""

    def __init__(self):
        self.answers: dict = {}
        self.calls: list[dict] = []
        self.embedded: list[str] = []
        self.embeddings_fail = False

    def embed_texts(self, texts, task_type):
        if self.embeddings_fail:
            raise AppError(503, "ai_unavailable", "The AI step failed. Try again in a minute.")
        self.embedded += texts
        return [word_vector(t) for t in texts]

    def generate_json(self, task, prompt, schema, file=None, **settings):
        self.calls.append({"task": task, "prompt": prompt, "file": file, **settings})
        if task not in self.answers:
            raise AppError(503, "ai_unavailable", "The AI step failed. Try again in a minute.")
        return schema.model_validate(self.answers[task](prompt, file))


# The day the tests run on, whatever the calendar says: their fixed dates (ship dates, the
# 1 Jan 2027 tariff change in reference.json) stay where they are relative to it.
TEST_TODAY = date(2026, 11, 20)


@pytest.fixture(autouse=True)
def fixed_today(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(clock, "today", lambda: TEST_TODAY)


@pytest.fixture(autouse=True)
def fake_gemini(monkeypatch: pytest.MonkeyPatch) -> FakeGemini:
    fake = FakeGemini()
    monkeypatch.setattr(gemini, "generate_json", fake.generate_json)
    monkeypatch.setattr(gemini, "embed_texts", fake.embed_texts)
    return fake


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def auth_header(email: str) -> dict[str, str]:
    return {"Authorization": f"Bearer dev:{email}"}


def onboard(client: TestClient, email: str, company: str = "Binh Duong Wood Co.") -> dict:
    headers = auth_header(email)
    response = client.post(
        "/api/v1/onboarding",
        headers=headers,
        json={
            "companyName": company,
            "businessRole": "Manufacturer",
            "origin": "Vietnam",
            "destination": "European Union",
            "description": "Plywood and wooden furniture maker in Binh Duong, Vietnam.",
        },
    )
    assert response.status_code == 201, response.text
    return headers


def add_member(client: TestClient, owner_email: str, email: str, role: Role) -> dict:
    """Put `email` into the owner's company with `role`, skipping the invitation."""
    headers = auth_header(email)
    client.get("/api/v1/me", headers=headers)  # creates the user row
    with open_session() as db:
        owner = user_queries.get_user_by_firebase_uid(db, f"dev:{owner_email}")
        member = user_queries.get_user_by_firebase_uid(db, f"dev:{email}")
        _, company = user_queries.get_user_company_membership(db, owner.id)
        user_queries.add_membership(db, user_id=member.id, company_id=company.id, role=role)
        db.commit()
    return headers


def upload_csv(client: TestClient, headers: dict, content: str, filename: str = "orders.csv"):
    return client.post(
        "/api/v1/imports",
        headers=headers,
        files={"file": (filename, content.encode("utf-8"), "text/csv")},
    )


def import_orders(client: TestClient, headers: dict, content: str = VALID_CSV) -> dict:
    uploaded = upload_csv(client, headers, content)
    assert uploaded.status_code == 201, uploaded.text
    import_id = uploaded.json()["data"]["id"]
    committed = client.post(f"/api/v1/imports/{import_id}/commit", headers=headers)
    assert committed.status_code == 200, committed.text
    return uploaded.json()["data"]
