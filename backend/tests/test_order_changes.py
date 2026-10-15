from datetime import UTC, datetime, timedelta

import pytest
from conftest import add_member, import_orders, onboard
from sqlalchemy import func, select

from app.database.models import (
    AnalysisReport,
    AuditEvent,
    HsCodeSuggestion,
    HsSuggestionStatus,
    Order,
    OrderStatusChange,
    Role,
)
from app.database.queries import users as user_queries
from app.database.session import open_session
from app.seed_demo_data import seed_company_map_data
from app.seed_reference_data import seed_reference_data

TODAY = datetime.now(UTC).date()
SHIP = (TODAY + timedelta(days=10)).isoformat()
# PO-1 to the EU from a supplier without plot geolocation: exposed after the import's analysis.
ORDERS = (
    "id,product,supplier,destination,value,shipDate,hsCode\n"
    f'PO-1,Oak dining table,Binh Phu Wood,"Rotterdam, NL",48100,{SHIP},9403.60\n'
    f'PO-2,Oak chair,Binh Phu Wood,"Rotterdam, NL",1200,{SHIP},9401.61\n'
)


@pytest.fixture
def lan(client) -> dict:
    headers = onboard(client, "lan@example.com")
    with open_session() as db:
        seed_reference_data(db)
        user = user_queries.get_user_by_firebase_uid(db, "dev:lan@example.com")
        _, company = user_queries.get_user_company_membership(db, user.id)
        seed_company_map_data(db, company.id)
    import_orders(client, headers, ORDERS)
    return headers


def edit(client, headers, change: dict, order_id: str = "PO-1"):
    return client.patch(f"/api/v1/orders/{order_id}", headers=headers, json=change)


def audit_events(action: str) -> list[AuditEvent]:
    with open_session() as db:
        return list(db.scalars(select(AuditEvent).where(AuditEvent.action == action)))


def test_an_edit_is_saved_audited_and_analysed_again(client, lan):
    before = client.get("/api/v1/orders/PO-1", headers=lan).json()["data"]
    later = (TODAY + timedelta(days=30)).isoformat()
    response = edit(
        client,
        lan,
        {
            "product": "  Oak dining table, 8 seats ",
            "supplier": "An Cuong Wood",
            "valueMinor": 5100050,
            "currency": "eur",
            "shipDate": later,
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    order = data["detail"]["order"]
    assert order == {
        **before["order"],
        "product": "Oak dining table, 8 seats",
        "supplier": "An Cuong Wood",
        "valueMinor": 5100050,
        "currency": "EUR",
        "shipDate": later,
        "status": order["status"],
    }
    # The latest report was made from the old facts, so the order is analysed again.
    assert data["run"]["status"] == "done"
    assert data["run"]["orderCount"] == 1
    assert data["detail"]["latestReportId"] not in (None, before["latestReportId"])
    assert data["detail"]["source"] == before["source"]  # the CSV row stays as imported

    [event] = audit_events("order.updated")
    assert (event.object_type, event.object_id) == ("order", "PO-1")
    assert event.data == {
        "currency": {"from": "USD", "to": "EUR"},
        "product": {"from": "Oak dining table", "to": "Oak dining table, 8 seats"},
        "shipDate": {"from": SHIP, "to": later},
        "supplier": {"from": "Binh Phu Wood", "to": "An Cuong Wood"},
        "valueMinor": {"from": 4810000, "to": 5100050},
    }
    listed = client.get("/api/v1/orders", headers=lan).json()["data"]
    assert [o["supplier"] for o in listed if o["id"] == "PO-1"] == ["An Cuong Wood"]
    # The other order is not touched.
    assert [o["product"] for o in listed if o["id"] == "PO-2"] == ["Oak chair"]


def test_an_edit_that_changes_nothing_saves_and_runs_nothing(client, lan):
    before = client.get("/api/v1/orders/PO-1", headers=lan).json()["data"]
    response = edit(client, lan, {"product": "Oak dining table", "currency": "usd"})
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["run"] is None
    assert data["detail"] == before
    assert audit_events("order.updated") == []


def test_clearing_the_hs_code_makes_analysis_ask_for_it(client, lan):
    response = edit(client, lan, {"hsCode": ""})
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["detail"]["order"]["hsCode"] == ""
    assert data["detail"]["order"]["status"] == "exposed"
    [event] = audit_events("order.updated")
    assert event.data == {"hsCode": {"from": "9403.60", "to": ""}}


def test_typing_an_hs_code_settles_waiting_suggestions(client, lan):
    assert edit(client, lan, {"hsCode": ""}).status_code == 200
    with open_session() as db:
        order = db.scalar(select(Order).where(Order.external_id == "PO-1"))
        db.add(
            HsCodeSuggestion(
                company_id=order.company_id,
                order_id=order.id,
                hs_code="9403.60",
                description="Other wooden furniture",
                reason="Wooden table.",
                created_by=db.scalar(select(AuditEvent.user_id).limit(1)),
            )
        )
        db.commit()
    response = edit(client, lan, {"hsCode": " 9403.60.80 "})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["detail"]["order"]["hsCode"] == "9403.60.80"
    with open_session() as db:
        assert db.scalar(select(HsCodeSuggestion.status)) == HsSuggestionStatus.rejected


@pytest.mark.parametrize(
    "change, field",
    [
        ({"product": "  "}, "product"),
        ({"product": None}, "request"),
        ({"supplier": "x" * 301}, "supplier"),
        ({"destination": ""}, "destination"),
        ({"valueMinor": 0}, "valueMinor"),
        ({"valueMinor": -100}, "valueMinor"),
        ({"currency": "EURO"}, "currency"),
        ({"shipDate": "15/10/2026"}, "shipDate"),
        ({"hsCode": "44.12"}, "hsCode"),
        ({"hsCode": None}, "request"),
    ],
)
def test_an_edit_follows_the_csv_rules(client, lan, change, field):
    response = edit(client, lan, change)
    assert response.status_code == 422, response.text
    assert field in response.json()["error"]["fieldErrors"]
    assert audit_events("order.updated") == []


def test_the_order_id_is_not_changed(client, lan):
    response = edit(client, lan, {"id": "PO-9", "product": "Oak table"})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["detail"]["order"]["id"] == "PO-1"
    assert client.get("/api/v1/orders/PO-9", headers=lan).status_code == 404


def test_viewers_cannot_edit_or_remove_and_other_companies_get_404(client, lan):
    viewer = add_member(client, "lan@example.com", "minh@example.com", Role.viewer)
    assert edit(client, viewer, {"product": "Oak table"}).status_code == 403
    assert client.delete("/api/v1/orders/PO-1", headers=viewer).status_code == 403
    stranger = onboard(client, "tuan@example.com", company="Other Co.")
    assert edit(client, stranger, {"product": "Oak table"}).status_code == 404
    assert client.delete("/api/v1/orders/PO-1", headers=stranger).status_code == 404
    assert client.get("/api/v1/orders/PO-1", headers=lan).json()["data"]["order"]["product"] == (
        "Oak dining table"
    )
    assert audit_events("order.updated") == audit_events("order.deleted") == []


def test_removing_an_order_takes_its_history_and_reports_and_keeps_an_audit_record(client, lan):
    assert edit(client, lan, {"supplier": "An Cuong Wood"}).status_code == 200
    with open_session() as db:
        order_id = db.scalar(select(Order.id).where(Order.external_id == "PO-1"))
        assert db.scalar(select(func.count()).where(AnalysisReport.order_id == order_id)) == 2

    response = client.delete("/api/v1/orders/PO-1", headers=lan)
    assert response.status_code == 200, response.text
    assert response.json()["data"] == {"deleted": True}
    assert client.get("/api/v1/orders/PO-1", headers=lan).status_code == 404
    assert client.delete("/api/v1/orders/PO-1", headers=lan).status_code == 404
    assert [o["id"] for o in client.get("/api/v1/orders", headers=lan).json()["data"]] == ["PO-2"]
    assert client.get("/api/v1/overview", headers=lan).json()["data"]["totalOrders"] == 1
    with open_session() as db:
        assert db.scalar(select(func.count()).where(AnalysisReport.order_id == order_id)) == 0
        assert db.scalar(select(func.count()).where(OrderStatusChange.order_id == order_id)) == 0

    [event] = audit_events("order.deleted")
    assert (event.object_type, event.object_id) == ("order", "PO-1")
    assert event.data == {
        "product": "Oak dining table",
        "supplier": "An Cuong Wood",
        "destination": "Rotterdam, NL",
        "valueMinor": 4810000,
        "currency": "USD",
        "shipDate": SHIP,
        "hsCode": "9403.60",
        "status": event.data["status"],
    }

    # The id is free again: the same row can be imported once more.
    import_orders(
        client,
        lan,
        "id,product,supplier,destination,value,shipDate,hsCode\n"
        f'PO-1,Oak dining table,Binh Phu Wood,"Rotterdam, NL",48100,{SHIP},9403.60\n',
    )
    assert client.get("/api/v1/orders/PO-1", headers=lan).status_code == 200
