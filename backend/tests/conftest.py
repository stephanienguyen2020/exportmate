"""Tests run against a real Postgres database (TEST_DATABASE_URL), migrated with Alembic.

Never point TEST_DATABASE_URL at a database you care about: its schema is dropped each run.
"""

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import text

from app import seed_reference_data
from app.core.config import get_settings
from app.database.models import Base, Role
from app.database.queries import users as user_queries
from app.database.session import get_engine, open_session
from app.main import create_app
from app.services import regulations as regulation_service

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
    get_settings.cache_clear()
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


@pytest.fixture(autouse=True)
def file_storage(monkeypatch: pytest.MonkeyPatch) -> InMemoryFileStorage:
    storage = InMemoryFileStorage()
    monkeypatch.setattr(regulation_service, "get_file_storage", lambda: storage)
    return storage


def fake_official_text(url: str, accept: str | None) -> bytes:
    """A small, distinct file per URL, so the seed never downloads real law texts in tests.
    Only .pdf files are checked for content, so a PDF header suits every source."""
    return f"%PDF-1.7 official text from {url}".encode()


@pytest.fixture(autouse=True)
def official_texts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(seed_reference_data, "fetch_official_text", fake_official_text)


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
    """Put `email` into the owner's company with `role` (no invite API yet)."""
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
