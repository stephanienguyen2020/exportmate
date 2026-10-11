from conftest import import_orders, onboard
from sqlalchemy import update

from app.database.models import Order, OrderStatus
from app.database.session import open_session

MANY_ORDERS_CSV = "id,product,supplier,destination,value,shipDate,hsCode\n" + "".join(
    f"PO-{i:02d},Plywood {i},Binh Phu,NL,{100 + i},2026-11-{i:02d},4412.33\n" for i in range(1, 8)
)


def set_order_status(external_id: str, status: OrderStatus) -> None:
    """Stand-in for the phase 2 analysis, which will set statuses for real."""
    with open_session() as db:
        db.execute(update(Order).where(Order.external_id == external_id).values(status=status))
        db.commit()


def test_list_is_sorted_by_ship_date_and_paginates(client):
    headers = onboard(client, "lan@example.com")
    import_orders(client, headers, MANY_ORDERS_CSV)

    first = client.get("/api/v1/orders?limit=3", headers=headers).json()
    assert [o["id"] for o in first["data"]] == ["PO-01", "PO-02", "PO-03"]
    assert first["meta"]["total"] == 7

    cursor = first["meta"]["nextCursor"]
    second = client.get(f"/api/v1/orders?limit=3&cursor={cursor}", headers=headers).json()
    assert [o["id"] for o in second["data"]] == ["PO-04", "PO-05", "PO-06"]

    last = client.get(
        f"/api/v1/orders?limit=3&cursor={second['meta']['nextCursor']}", headers=headers
    ).json()
    assert [o["id"] for o in last["data"]] == ["PO-07"]
    assert last["meta"]["nextCursor"] is None


def test_filter_by_status_and_search(client):
    headers = onboard(client, "lan@example.com")
    import_orders(client, headers, MANY_ORDERS_CSV)
    set_order_status("PO-02", OrderStatus.exposed)

    exposed = client.get("/api/v1/orders?status=exposed", headers=headers).json()
    assert [o["id"] for o in exposed["data"]] == ["PO-02"]

    found = client.get("/api/v1/orders?q=plywood 5", headers=headers).json()
    assert [o["id"] for o in found["data"]] == ["PO-05"]

    # % and _ are matched literally, not as wildcards.
    assert client.get("/api/v1/orders?q=%25", headers=headers).json()["meta"]["total"] == 0


def test_bad_cursor_is_422(client):
    headers = onboard(client, "lan@example.com")
    response = client.get("/api/v1/orders?cursor=nonsense", headers=headers)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_cursor"


def test_other_company_cannot_read_order(client):
    lan = onboard(client, "lan@example.com")
    other = onboard(client, "mai@example.com", company="Other Co")
    import_orders(client, lan)

    assert client.get("/api/v1/orders/PO-1", headers=lan).status_code == 200
    assert client.get("/api/v1/orders/PO-1", headers=other).status_code == 404
    assert client.get("/api/v1/orders", headers=other).json()["meta"]["total"] == 0


def test_overview(client):
    headers = onboard(client, "lan@example.com")
    import_orders(client, headers, MANY_ORDERS_CSV)
    set_order_status("PO-03", OrderStatus.exposed)
    set_order_status("PO-05", OrderStatus.exposed)

    data = client.get("/api/v1/overview", headers=headers).json()["data"]
    assert data["totalOrders"] == 7
    assert data["countsByStatus"] == {
        "awaiting_analysis": 5,
        "clear": 0,
        "exposed": 2,
        "needs_data": 0,
    }
    assert data["valueAtRiskByCurrency"] == {"USD": (103 + 105) * 100}
    assert data["nearestAffectedShipDate"] == "2026-11-03"
