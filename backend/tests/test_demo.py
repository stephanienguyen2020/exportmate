from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from conftest import auth_header, onboard, upload_csv
from fastapi.testclient import TestClient
from sqlalchemy import func, select, update

from app.api import demo as demo_api
from app.database.models import Company, Order, User
from app.database.session import open_session
from app.seed_reference_data import seed_reference_data
from app.services import demo as demo_service

# The sample orders the frontend offers a demo visitor to import.
SAMPLE_ORDERS = (
    Path(__file__).resolve().parents[2] / "frontend/public/samples/exportmate-sample-orders.csv"
)


def visitor(name: str) -> dict[str, str]:
    return {"Authorization": f"Bearer dev-anonymous:{name}"}


@pytest.fixture(autouse=True)
def fresh_rate_limit() -> None:
    # Counted in memory per process, so each test starts from none.
    demo_api.sandbox_limiter._hits.clear()


@pytest.fixture(autouse=True)
def reference_data() -> None:
    with open_session() as db:
        seed_reference_data(db)


def open_demo(client, headers):
    response = client.post("/api/v1/demo", headers=headers)
    assert response.status_code == 201, response.text
    return response.json()["data"]


def test_visitor_gets_their_own_sandbox_of_the_demo_company(client):
    a = open_demo(client, visitor("a"))
    b = open_demo(client, visitor("b"))
    assert a["company"]["name"] == "Binh Duong Wood Co."
    assert a["company"]["id"] != b["company"]["id"]
    assert a["role"] == "owner"
    assert a["company"]["demoExpiresAt"]
    # Opening it again keeps the same sandbox.
    assert open_demo(client, visitor("a"))["company"]["id"] == a["company"]["id"]

    # Profile, rules and the trade map are there; the orders are left to import.
    rules = client.get("/api/v1/playbook/rules", headers=visitor("a"))
    assert rules.status_code == 200, rules.text
    assert len(rules.json()["data"]) == 3
    trade_map = client.get("/api/v1/trade-map", headers=visitor("a")).json()["data"]
    assert trade_map["suppliers"]
    assert client.get("/api/v1/orders", headers=visitor("a")).json()["data"] == []


def test_visitor_imports_the_sample_orders(client):
    open_demo(client, visitor("a"))
    sample = SAMPLE_ORDERS.read_text()
    uploaded = upload_csv(client, visitor("a"), sample)
    assert uploaded.status_code == 201, uploaded.text
    assert uploaded.json()["data"]["status"] == "validated"
    import_id = uploaded.json()["data"]["id"]
    committed = client.post(f"/api/v1/imports/{import_id}/commit", headers=visitor("a"))
    assert committed.status_code == 200, committed.text
    assert committed.json()["data"]["ordersCreated"] == len(sample.splitlines()) - 1
    # Another visitor's sandbox doesn't see them.
    open_demo(client, visitor("b"))
    assert client.get("/api/v1/orders", headers=visitor("b")).json()["data"] == []


def test_visitor_cannot_create_a_real_company_or_send_email(client):
    refused = client.post(
        "/api/v1/onboarding",
        headers=visitor("a"),
        json={
            "companyName": "Mine",
            "businessRole": "Manufacturer",
            "origin": "Vietnam",
            "destination": "European Union",
            "description": "A company.",
        },
    )
    assert refused.status_code == 403
    assert refused.json()["error"]["code"] == "demo_visitor"
    # Before opening the demo there is no workspace.
    assert client.get("/api/v1/orders", headers=visitor("a")).status_code == 403

    open_demo(client, visitor("a"))
    invite = client.post(
        "/api/v1/company/invites",
        headers=visitor("a"),
        json={"email": "someone@example.com", "role": "editor"},
    )
    assert invite.status_code == 403
    assert invite.json()["error"]["code"] == "demo_no_email"


def test_signed_in_user_cannot_open_a_demo(client):
    onboard(client, "lan@example.com")
    response = client.post("/api/v1/demo", headers=auth_header("lan@example.com"))
    assert response.status_code == 409


def test_expired_sandbox_ends_and_is_deleted(client):
    a = open_demo(client, visitor("a"))
    with open_session() as db:
        db.execute(
            update(Company)
            .where(Company.id == a["company"]["id"])
            .values(demo_expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        db.commit()
    expired = client.get("/api/v1/orders", headers=visitor("a"))
    assert expired.status_code == 401
    assert expired.json()["error"]["code"] == "demo_expired"

    # The next visitor's sandbox clears it away, with its visitor.
    open_demo(client, visitor("b"))
    with open_session() as db:
        assert db.get(Company, a["company"]["id"]) is None
        assert db.scalar(select(func.count()).select_from(User)) == 1
        assert db.scalar(select(func.count()).select_from(Order)) == 0
        assert demo_service.delete_expired_sandboxes(db) == 0


def test_a_sandbox_that_fails_to_seed_is_not_kept(client, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("map data unavailable")

    with monkeypatch.context() as patched:
        patched.setattr(demo_service, "seed_company_map_data", broken)
        failing = TestClient(client.app, raise_server_exceptions=False)
        assert failing.post("/api/v1/demo", headers=visitor("a")).status_code == 500
    with open_session() as db:
        assert db.scalar(select(func.count()).select_from(Company)) == 0
    assert open_demo(client, visitor("a"))["company"]["name"] == "Binh Duong Wood Co."


def test_real_companies_are_never_deleted(client):
    onboard(client, "lan@example.com")
    with open_session() as db:
        assert demo_service.delete_expired_sandboxes(db) == 0
        assert db.scalar(select(func.count()).select_from(Company)) == 1


def test_visitor_whose_sandbox_expired_gets_a_new_one(client):
    a = open_demo(client, visitor("a"))
    with open_session() as db:
        db.execute(
            update(Company)
            .where(Company.id == a["company"]["id"])
            .values(demo_expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        db.commit()
    again = open_demo(client, visitor("a"))
    assert again["company"]["id"] != a["company"]["id"]
    assert client.get("/api/v1/orders", headers=visitor("a")).status_code == 200
    with open_session() as db:
        assert db.get(Company, a["company"]["id"]) is None
