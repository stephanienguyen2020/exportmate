from datetime import UTC, datetime, timedelta

import pytest
from conftest import add_member, import_orders, onboard
from sqlalchemy import select, update

from app.core.config import get_settings
from app.database.models import (
    AuditEvent,
    Order,
    OrderStatus,
    OrderStatusChange,
    OrderStatusDefinition,
    Role,
)
from app.database.queries import users as user_queries
from app.database.session import open_session
from app.seed_data import load_seed_file
from app.seed_demo_data import seed_company_map_data
from app.seed_reference_data import seed_order_statuses, seed_reference_data

TODAY = datetime.now(UTC).date()
# PO-1 to the EU, 10 days out, from a supplier without plot geolocation: exposed after analysis.
ORDERS = (
    "id,product,supplier,destination,value,shipDate,hsCode\n"
    f'PO-1,Oak dining table,Binh Phu Wood,"Rotterdam, NL",48100,'
    f"{(TODAY + timedelta(days=10)).isoformat()},9403.60\n"
)
THREE_ORDERS = "".join(
    [ORDERS]
    + [
        f'PO-{n},Oak chair,Binh Phu Wood,"Rotterdam, NL",1200,'
        f"{(TODAY + timedelta(days=10 + n)).isoformat()},9401.61\n"
        for n in (2, 3)
    ]
)


@pytest.fixture
def lan(client) -> dict:
    headers = onboard(client, "lan@example.com")
    with open_session() as db:
        seed_order_statuses(db)
        db.commit()
    import_orders(client, headers, ORDERS)
    return headers


def change(client, headers, status: str, note: str = "Buyer confirmed the documents by email."):
    return client.patch(
        "/api/v1/orders/PO-1/status", headers=headers, json={"status": status, "note": note}
    )


def test_statuses_come_from_the_database(client, lan):
    response = client.get("/api/v1/order-statuses", headers=lan)
    assert response.status_code == 200, response.text
    seeded = load_seed_file("reference.json")["orderStatuses"]
    assert [(s["code"], s["label"], s["tone"]) for s in response.json()["data"]] == [
        (s["code"], s["label"], s["tone"]) for s in seeded
    ]
    with open_session() as db:
        db.execute(
            update(OrderStatusDefinition)
            .where(OrderStatusDefinition.code == OrderStatus.clear)
            .values(label="Ready to ship")
        )
        db.commit()
    labels = {
        s["code"]: s["label"]
        for s in client.get("/api/v1/order-statuses", headers=lan).json()["data"]
    }
    assert labels["clear"] == "Ready to ship"


def test_manual_change_is_saved_with_its_note_and_audited(client, lan):
    response = change(client, lan, "clear", "  Buyer confirmed the documents by email.  ")
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["order"]["status"] == "clear"
    [entry] = data["statusChanges"]
    assert entry["fromStatus"] == "awaiting_analysis"
    assert entry["toStatus"] == "clear"
    assert entry["source"] == "manual"
    assert entry["note"] == "Buyer confirmed the documents by email."
    assert entry["changedBy"]["name"]
    assert entry["runId"] is None

    with open_session() as db:
        order = db.scalar(select(Order).where(Order.external_id == "PO-1"))
        assert order.status == OrderStatus.clear
        row = db.scalar(select(OrderStatusChange).where(OrderStatusChange.order_id == order.id))
        assert (row.from_status, row.to_status, row.note) == (
            OrderStatus.awaiting_analysis,
            OrderStatus.clear,
            "Buyer confirmed the documents by email.",
        )
        event = db.scalar(select(AuditEvent).where(AuditEvent.action == "order.status_changed"))
        assert (event.object_type, event.object_id) == ("order", "PO-1")
        assert event.data == {
            "from": "awaiting_analysis",
            "to": "clear",
            "note": "Buyer confirmed the documents by email.",
        }

    detail = client.get("/api/v1/orders/PO-1", headers=lan).json()["data"]
    assert [c["id"] for c in detail["statusChanges"]] == [entry["id"]]
    listed = client.get("/api/v1/orders?status=clear", headers=lan).json()["data"]
    assert [o["id"] for o in listed] == ["PO-1"]
    audit = client.get("/api/v1/audit-events", headers=lan).json()["data"]
    assert any(e["action"] == "order.status_changed" for e in audit)


@pytest.mark.parametrize("note", ["", "   "])
def test_a_note_is_required(client, lan, note):
    assert change(client, lan, "clear", note).status_code == 422
    assert client.get("/api/v1/orders/PO-1", headers=lan).json()["data"]["statusChanges"] == []


def test_the_same_status_again_is_refused(client, lan):
    response = change(client, lan, "awaiting_analysis")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "status_unchanged"


def test_a_status_the_database_does_not_allow_by_hand_is_refused(client, lan):
    with open_session() as db:
        db.execute(
            update(OrderStatusDefinition)
            .where(OrderStatusDefinition.code == OrderStatus.clear)
            .values(manual=False)
        )
        db.commit()
    response = change(client, lan, "clear")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "status_not_settable"
    with open_session() as db:
        assert (
            db.scalar(select(AuditEvent).where(AuditEvent.action == "order.status_changed")) is None
        )


def test_viewers_cannot_change_a_status_and_other_companies_get_404(client, lan):
    viewer = add_member(client, "lan@example.com", "minh@example.com", Role.viewer)
    assert change(client, viewer, "clear").status_code == 403
    stranger = onboard(client, "tuan@example.com", company="Other Co.")
    assert change(client, stranger, "clear").status_code == 404
    with open_session() as db:
        assert db.scalar(select(OrderStatusChange.id)) is None


def test_an_analysis_after_a_manual_change_is_recorded_too(client):
    headers = onboard(client, "lan@example.com")
    with open_session() as db:
        seed_reference_data(db)
        user = user_queries.get_user_by_firebase_uid(db, "dev:lan@example.com")
        _, company = user_queries.get_user_company_membership(db, user.id)
        seed_company_map_data(db, company.id)
    import_orders(client, headers, ORDERS)
    assert change(client, headers, "clear").status_code == 200

    run = client.post("/api/v1/runs", headers=headers)
    assert run.status_code == 201, run.text
    detail = client.get("/api/v1/orders/PO-1", headers=headers).json()["data"]
    assert detail["order"]["status"] == "exposed"
    latest, manual = detail["statusChanges"]
    assert (latest["source"], latest["fromStatus"], latest["toStatus"]) == (
        "analysis",
        "clear",
        "exposed",
    )
    assert latest["runId"] == run.json()["data"]["id"]
    assert latest["note"] is None
    assert manual["source"] == "manual"

    # A second run that doesn't change the status adds nothing.
    assert client.post("/api/v1/runs", headers=headers).status_code == 201
    detail = client.get("/api/v1/orders/PO-1", headers=headers).json()["data"]
    assert len(detail["statusChanges"]) == 2


def change_many(client, headers, ids, status, note="Buyer confirmed the documents by email."):
    return client.patch(
        "/api/v1/orders/status",
        headers=headers,
        json={"orderIds": ids, "status": status, "note": note},
    )


@pytest.fixture
def lan3(client) -> dict:
    headers = onboard(client, "lan@example.com")
    with open_session() as db:
        seed_order_statuses(db)
        db.commit()
    import_orders(client, headers, THREE_ORDERS)
    return headers


def test_several_orders_change_together_each_with_its_history_and_audit(client, lan3):
    assert change(client, lan3, "needs_data").status_code == 200  # PO-1, before
    # A repeated id counts once.
    response = change_many(
        client, lan3, ["PO-3", "PO-1", "PO-3", "PO-2"], "clear", "  Buyer sent it.  "
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert [o["id"] for o in data["changed"]] == ["PO-3", "PO-1", "PO-2"]
    assert {o["status"] for o in data["changed"]} == {"clear"}
    assert data["unchanged"] == []

    for order_id, before in (("PO-1", "needs_data"), ("PO-2", "awaiting_analysis")):
        detail = client.get(f"/api/v1/orders/{order_id}", headers=lan3).json()["data"]
        latest = detail["statusChanges"][0]
        assert (latest["fromStatus"], latest["toStatus"], latest["note"], latest["source"]) == (
            before,
            "clear",
            "Buyer sent it.",
            "manual",
        )
    with open_session() as db:
        events = db.scalars(
            select(AuditEvent).where(
                AuditEvent.action == "order.status_changed",
                AuditEvent.data["to"].astext == "clear",
            )
        ).all()
        assert sorted(e.object_id for e in events) == ["PO-1", "PO-2", "PO-3"]


def test_orders_that_already_have_the_status_are_left_alone(client, lan3):
    assert change(client, lan3, "clear").status_code == 200  # PO-1
    response = change_many(client, lan3, ["PO-1", "PO-2"], "clear")
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert [o["id"] for o in data["changed"]] == ["PO-2"]
    assert data["unchanged"] == ["PO-1"]
    detail = client.get("/api/v1/orders/PO-1", headers=lan3).json()["data"]
    assert len(detail["statusChanges"]) == 1

    response = change_many(client, lan3, ["PO-1", "PO-2"], "clear")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "status_unchanged"


def test_all_or_none_when_an_order_is_missing_or_another_companys(client, lan3):
    stranger = onboard(client, "tuan@example.com", company="Other Co.")
    import_orders(client, stranger, ORDERS.replace("PO-1", "PO-9"))
    response = change_many(client, lan3, ["PO-1", "PO-9", "PO-404"], "clear")
    assert response.status_code == 404
    assert response.json()["error"]["fieldErrors"]["orderIds"] == "Not found: PO-9, PO-404"
    with open_session() as db:
        assert db.scalar(select(OrderStatusChange.id)) is None
        assert db.scalar(select(Order.status).where(Order.external_id == "PO-1")) == (
            OrderStatus.awaiting_analysis
        )


def test_bulk_change_needs_an_editor_a_note_and_a_settable_status(client, lan3):
    viewer = add_member(client, "lan@example.com", "minh@example.com", Role.viewer)
    assert change_many(client, viewer, ["PO-1"], "clear").status_code == 403
    assert change_many(client, lan3, ["PO-1"], "clear", "  ").status_code == 422
    assert change_many(client, lan3, [], "clear").status_code == 422
    with open_session() as db:
        db.execute(
            update(OrderStatusDefinition)
            .where(OrderStatusDefinition.code == OrderStatus.clear)
            .values(manual=False)
        )
        db.commit()
    response = change_many(client, lan3, ["PO-1", "PO-2"], "clear")
    assert response.json()["error"]["code"] == "status_not_settable"
    with open_session() as db:
        assert db.scalar(select(OrderStatusChange.id)) is None


def test_the_most_orders_at_once_is_a_setting(client, lan3, monkeypatch):
    monkeypatch.setenv("MAX_STATUS_CHANGE_ORDERS", "2")
    get_settings.cache_clear()
    try:
        response = change_many(client, lan3, ["PO-1", "PO-2", "PO-3"], "clear")
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "too_many_orders"
        assert change_many(client, lan3, ["PO-1", "PO-2"], "clear").status_code == 200
    finally:
        monkeypatch.delenv("MAX_STATUS_CHANGE_ORDERS")
        get_settings.cache_clear()
