import pytest
from conftest import add_member, import_orders, onboard
from sqlalchemy import select

from app.database.models import AuditEvent, Role
from app.database.session import open_session
from app.seed_reference_data import seed_reference_data
from app.services.company_sites import new_site_key

ORDERS_CSV = (
    "id,product,supplier,destination,value,shipDate,hsCode\n"
    'PO-1,Acacia plywood 18 mm,Dong Nai  veneer,"Rotterdam, NL",24000,2026-10-27,4412.33\n'
)
SUPPLIER = {
    "name": "Dong Nai Veneer",
    "place": "Bien Hoa, Dong Nai",
    "country": "vn",
    "location": {"latitude": 10.95, "longitude": 106.82},
    "supplies": "Acacia veneer",
    "documents": [
        {"kind": "legality", "detail": "VNTLAS dossier"},
        {"kind": "formaldehyde", "detail": "Test, May 2026", "standards": ["EN 717-1"]},
    ],
}
SITE = {
    "kind": "warehouse",
    "name": "Da Nang warehouse",
    "place": "Tien Sa port, Da Nang",
    "country": "VN",
    "location": {"latitude": 16.12, "longitude": 108.21},
}


@pytest.fixture
def reference() -> None:
    with open_session() as db:
        seed_reference_data(db)


def get_map(client, headers) -> dict:
    response = client.get("/api/v1/trade-map", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def checks_of(data: dict, order_id: str) -> dict[str, str]:
    order = next(o for o in data["orders"] if o["order"]["id"] == order_id)
    return {c["requirementKey"]: c["status"] for c in order["checks"]}


def audit_actions(prefix: str = "") -> list[str]:
    with open_session() as db:
        actions = db.scalars(select(AuditEvent.action).order_by(AuditEvent.created_at))
        return [action for action in actions if action.startswith(prefix)]


def latest_report(client, headers, order_id: str) -> dict:
    detail = client.get(f"/api/v1/orders/{order_id}", headers=headers).json()["data"]
    response = client.get(f"/api/v1/reports/{detail['latestReportId']}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def test_new_supplier_is_matched_to_its_orders_and_checked(client, reference):
    headers = onboard(client, "lan@example.com")
    import_orders(client, headers, ORDERS_CSV)
    before = get_map(client, headers)
    assert checks_of(before, "PO-1")["legality"] == "unknown"
    assert any(c["code"] == "KH" for c in before["countries"])

    created = client.post("/api/v1/suppliers", headers=headers, json=SUPPLIER)
    assert created.status_code == 201, created.text
    supplier = created.json()["data"]
    assert supplier["country"] == "VN"
    assert [d["label"] for d in supplier["documents"]] == [
        "Formaldehyde emission test",
        "Timber legality evidence",
    ]

    after = get_map(client, headers)
    listed = next(s for s in after["suppliers"] if s["id"] == supplier["id"])
    # The order wrote "Dong Nai  veneer"; the name key ignores case and spacing.
    assert listed["orderIds"] == ["PO-1"]
    assert listed["location"] == {"latitude": 10.95, "longitude": 106.82}
    checks = checks_of(after, "PO-1")
    assert checks["legality"] == "on_file"
    assert checks["geolocation"] == "missing"
    assert audit_actions("supplier.")[-1] == "supplier.created"


def test_supplier_names_are_unique_per_company(client, reference):
    headers = onboard(client, "lan@example.com")
    assert client.post("/api/v1/suppliers", headers=headers, json=SUPPLIER).status_code == 201
    again = client.post("/api/v1/suppliers", headers=headers, json={"name": "  dong nai   VENEER "})
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "supplier_exists"

    # Another company may use the same name.
    other = onboard(client, "minh@example.com", company="Other Co.")
    assert client.post("/api/v1/suppliers", headers=other, json=SUPPLIER).status_code == 201


@pytest.mark.parametrize(
    ("change", "field"),
    [
        ({"country": "ZZ"}, "country"),
        ({"location": {"latitude": 95, "longitude": 106}}, "location.latitude"),
        ({"documents": [{"kind": "passport", "detail": "x"}]}, "documents"),
        (
            {
                "documents": [
                    {"kind": "legality", "detail": "a"},
                    {"kind": "legality", "detail": "b"},
                ]
            },
            "documents",
        ),
        ({"name": "   "}, "name"),
    ],
)
def test_invalid_suppliers_are_rejected(client, reference, change, field):
    headers = onboard(client, "lan@example.com")
    response = client.post("/api/v1/suppliers", headers=headers, json={**SUPPLIER, **change})
    assert response.status_code == 422, response.text
    assert field in response.json()["error"]["fieldErrors"]


def test_update_and_delete_supplier(client, reference):
    headers = onboard(client, "lan@example.com")
    import_orders(client, headers, ORDERS_CSV)
    supplier_id = client.post("/api/v1/suppliers", headers=headers, json=SUPPLIER).json()["data"][
        "id"
    ]

    updated = client.patch(
        f"/api/v1/suppliers/{supplier_id}",
        headers=headers,
        json={
            "place": "",
            "location": None,
            "documents": [{"kind": "geolocation", "detail": "Plot polygons"}],
        },
    )
    assert updated.status_code == 200, updated.text
    data = updated.json()["data"]
    assert data["place"] is None and data["location"] is None
    assert data["name"] == "Dong Nai Veneer"  # not sent, not changed
    assert [d["kind"] for d in data["documents"]] == ["geolocation"]
    checks = checks_of(get_map(client, headers), "PO-1")
    assert checks["geolocation"] == "on_file"
    assert checks["legality"] == "missing"

    cleared = client.patch(f"/api/v1/suppliers/{supplier_id}", headers=headers, json={"name": None})
    assert cleared.status_code == 422

    deleted = client.delete(f"/api/v1/suppliers/{supplier_id}", headers=headers)
    assert deleted.json()["data"] == {"deleted": True, "analysedOrderIds": ["PO-1"]}
    data = get_map(client, headers)
    # The order stays, named but without a record: supplier evidence is unknown again.
    assert [s["id"] for s in data["suppliers"]] == [None]
    assert checks_of(data, "PO-1")["legality"] == "unknown"
    assert audit_actions("supplier.") == [
        "supplier.created",
        "supplier.updated",
        "supplier.deleted",
    ]


def test_saving_a_supplier_analyses_the_orders_that_name_it(client, reference):
    headers = onboard(client, "lan@example.com")
    import_orders(
        client,
        headers,
        ORDERS_CSV
        + 'PO-2,Rubberwood sideboard,Tan Uyen Rubberwood,"Los Angeles, US",31600,2026-12-11,'
        "9403.60\n",
    )
    # Imported orders are analysed at once; without a record the next step is to add one.
    before = latest_report(client, headers, "PO-1")
    assert before["missingData"] == ["Add Dong Nai  veneer to the suppliers, with their documents."]
    assert before["suggestedAction"]["kind"] == "complete_data"
    # Each check names the document that answers it and the standards it accepts.
    us_checks = {c["requirementKey"]: c for c in latest_report(client, headers, "PO-2")["findings"]}
    assert us_checks["formaldehyde"]["documentKind"] == "formaldehyde"
    assert us_checks["formaldehyde"]["acceptedStandards"] == ["TSCA Title VI"]
    assert us_checks["lacey"]["documentKind"] is None

    created = client.post("/api/v1/suppliers", headers=headers, json=SUPPLIER).json()["data"]
    assert created["analysedOrderIds"] == ["PO-1"]
    after = latest_report(client, headers, "PO-1")
    assert after["id"] != before["id"]
    assert after["missingData"] == []
    assert after["suggestedAction"]["kind"] != "complete_data"
    assert latest_report(client, headers, "PO-2")["missingData"]  # another supplier: untouched

    def patch(change: dict) -> list[str]:
        response = client.patch(f"/api/v1/suppliers/{created['id']}", headers=headers, json=change)
        assert response.status_code == 200, response.text
        return response.json()["data"]["analysedOrderIds"]

    # Nothing an analysis reads: no new run.
    assert patch({"contactEmail": "sales@dongnai.example", "place": "Bien Hoa"}) == []
    assert patch({"documents": SUPPLIER["documents"][:1]}) == ["PO-1"]
    # A rename re-checks the orders it leaves and the orders it now matches.
    assert patch({"name": "Tan Uyen Rubberwood"}) == ["PO-1", "PO-2"]
    assert latest_report(client, headers, "PO-1")["missingData"] == [
        "Add Dong Nai  veneer to the suppliers, with their documents."
    ]
    assert latest_report(client, headers, "PO-2")["missingData"] == []


def test_renaming_into_another_suppliers_name_conflicts(client, reference):
    headers = onboard(client, "lan@example.com")
    client.post("/api/v1/suppliers", headers=headers, json=SUPPLIER)
    other_id = client.post("/api/v1/suppliers", headers=headers, json={"name": "Mekong Timber"})
    response = client.patch(
        f"/api/v1/suppliers/{other_id.json()['data']['id']}",
        headers=headers,
        json={"name": "dong nai veneer"},
    )
    assert response.status_code == 409


def test_viewers_cannot_change_places_and_companies_cannot_see_each_other(client, reference):
    headers = onboard(client, "lan@example.com")
    viewer = add_member(client, "lan@example.com", "viewer@example.com", Role.viewer)
    assert client.post("/api/v1/suppliers", headers=viewer, json=SUPPLIER).status_code == 403
    assert client.post("/api/v1/sites", headers=viewer, json=SITE).status_code == 403

    supplier_id = client.post("/api/v1/suppliers", headers=headers, json=SUPPLIER).json()["data"][
        "id"
    ]
    site_id = client.post("/api/v1/sites", headers=headers, json=SITE).json()["data"]["id"]
    other = onboard(client, "minh@example.com", company="Other Co.")
    assert (
        client.patch(f"/api/v1/suppliers/{supplier_id}", headers=other, json={}).status_code == 404
    )
    assert client.delete(f"/api/v1/suppliers/{supplier_id}", headers=other).status_code == 404
    assert client.patch(f"/api/v1/sites/{site_id}", headers=other, json={}).status_code == 404
    assert client.delete(f"/api/v1/sites/{site_id}", headers=other).status_code == 404


def test_sites_and_the_route_origin(client, reference):
    headers = onboard(client, "lan@example.com")
    factory = client.post(
        "/api/v1/sites",
        headers=headers,
        json={
            **SITE,
            "kind": "factory",
            "name": "Your factory",
            "shortName": "Factory",
            "isRouteOrigin": True,
        },
    )
    assert factory.status_code == 201, factory.text
    factory = factory.json()["data"]
    assert factory["key"] == "your-factory"
    assert factory["isRouteOrigin"] is True

    warehouse = client.post("/api/v1/sites", headers=headers, json=SITE).json()["data"]
    assert warehouse["shortName"] == "Da Nang warehouse"  # defaults to the name
    assert warehouse["note"] == ""
    twin = client.post("/api/v1/sites", headers=headers, json=SITE).json()["data"]
    assert twin["key"] == "da-nang-warehouse-2"

    # Marking another site moves the route origin.
    moved = client.patch(
        f"/api/v1/sites/{warehouse['id']}",
        headers=headers,
        json={"isRouteOrigin": True, "note": "  Central gateway  "},
    )
    assert moved.status_code == 200, moved.text
    assert moved.json()["data"]["note"] == "Central gateway"
    sites = {s["id"]: s for s in get_map(client, headers)["sites"]}
    assert sites[warehouse["id"]]["isRouteOrigin"] is True
    assert sites[factory["id"]]["isRouteOrigin"] is False
    assert sites[warehouse["id"]]["key"] == "da-nang-warehouse"  # keys never change

    assert (
        client.patch(
            f"/api/v1/sites/{warehouse['id']}", headers=headers, json={"location": None}
        ).status_code
        == 422
    )
    assert client.delete(f"/api/v1/sites/{twin['id']}", headers=headers).status_code == 200
    assert len(get_map(client, headers)["sites"]) == 2
    assert audit_actions()[-1] == "company_site.deleted"


def test_new_site_key():
    assert new_site_key("Cat Lai bonded warehouse", set()) == "cat-lai-bonded-warehouse"
    assert new_site_key("Kho Quy Nhơn", {"kho-quy-nh-n"}) == "kho-quy-nh-n-2"
    assert new_site_key("工厂", set()) == "site"
    assert len(new_site_key("x" * 300, set())) <= 50
