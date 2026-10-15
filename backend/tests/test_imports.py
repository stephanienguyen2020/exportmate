from conftest import VALID_CSV, add_member, import_orders, onboard, upload_csv

from app.core.config import get_settings
from app.database.models import Role


def test_upload_validates_and_previews(client):
    headers = onboard(client, "lan@example.com")
    response = upload_csv(client, headers, VALID_CSV)
    assert response.status_code == 201
    data = response.json()["data"]
    assert data["status"] == "validated"
    assert data["rowCount"] == 2
    assert data["errors"] == []
    assert [r["id"] for r in data["preview"]] == ["PO-1", "PO-2"]
    assert data["preview"][1]["hsCode"] == "0401.10"
    assert data["preview"][1]["valueMinor"] == 1999

    # Nothing is saved as an order until commit.
    assert client.get("/api/v1/orders", headers=headers).json()["meta"]["total"] == 0


def test_commit_keeps_the_orders_when_their_analysis_fails(client):
    # No reference data or cost settings are seeded here, so the analysis run fails.
    headers = onboard(client, "lan@example.com")
    uploaded = upload_csv(client, headers, VALID_CSV).json()["data"]
    committed = client.post(f"/api/v1/imports/{uploaded['id']}/commit", headers=headers)
    assert committed.status_code == 200, committed.text
    assert committed.json()["data"]["run"] is None

    orders = client.get("/api/v1/orders", headers=headers).json()["data"]
    assert {o["status"] for o in orders} == {"awaiting_analysis"}

    detail = client.get("/api/v1/orders/PO-1", headers=headers).json()["data"]
    assert detail["source"]["importId"] == uploaded["id"]
    assert detail["source"]["rowNumber"] == 2
    assert detail["source"]["raw"]["destination"] == "Rotterdam, NL"


def test_commit_twice_is_409(client):
    headers = onboard(client, "lan@example.com")
    uploaded = import_orders(client, headers)
    again = client.post(f"/api/v1/imports/{uploaded['id']}/commit", headers=headers)
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "already_committed"


def test_import_with_errors_cannot_be_committed(client):
    headers = onboard(client, "lan@example.com")
    bad = VALID_CSV + "PO-3,Plywood,Binh Phu,NL,abc,2026-10-27,4412.33\n"
    uploaded = upload_csv(client, headers, bad).json()["data"]
    assert uploaded["status"] == "invalid"
    assert uploaded["errors"] == [
        {
            "row": 4,
            "field": "value",
            "message": "Row 4: value must be a positive number with at most 2 decimals.",
        }
    ]
    commit = client.post(f"/api/v1/imports/{uploaded['id']}/commit", headers=headers)
    assert commit.status_code == 422
    assert client.get("/api/v1/orders", headers=headers).json()["meta"]["total"] == 0


def test_reupload_reports_existing_orders_and_duplicate_file(client):
    headers = onboard(client, "lan@example.com")
    first = import_orders(client, headers)
    second = upload_csv(client, headers, VALID_CSV).json()["data"]
    assert second["status"] == "invalid"
    assert [e["message"] for e in second["errors"]] == [
        "Row 2: order PO-1 already exists.",
        "Row 3: order PO-2 already exists.",
    ]
    assert second["duplicateOfImportId"] == first["id"]


def test_orders_added_after_validation_block_commit(client):
    headers = onboard(client, "lan@example.com")
    pending = upload_csv(client, headers, VALID_CSV).json()["data"]
    import_orders(client, headers)  # same orders committed by another upload
    commit = client.post(f"/api/v1/imports/{pending['id']}/commit", headers=headers)
    assert commit.status_code == 409
    assert commit.json()["error"]["code"] == "orders_already_exist"


def test_rejects_wrong_type_and_large_file(client, monkeypatch):
    headers = onboard(client, "lan@example.com")
    wrong = upload_csv(client, headers, VALID_CSV, filename="orders.xlsx")
    assert wrong.status_code == 422
    assert wrong.json()["error"]["code"] == "invalid_file_type"

    monkeypatch.setenv("MAX_UPLOAD_BYTES", "50")
    get_settings.cache_clear()
    try:
        large = upload_csv(client, headers, VALID_CSV)
    finally:
        monkeypatch.delenv("MAX_UPLOAD_BYTES")
        get_settings.cache_clear()
    assert large.status_code == 422
    assert large.json()["error"]["code"] == "file_too_large"


def test_viewer_cannot_import(client):
    onboard(client, "lan@example.com")
    viewer = add_member(client, "lan@example.com", "view@example.com", Role.viewer)
    assert upload_csv(client, viewer, VALID_CSV).status_code == 403


def test_other_company_cannot_see_or_commit_import(client):
    lan = onboard(client, "lan@example.com")
    other = onboard(client, "mai@example.com", company="Other Co")
    uploaded = upload_csv(client, lan, VALID_CSV).json()["data"]

    assert client.get(f"/api/v1/imports/{uploaded['id']}", headers=other).status_code == 404
    commit = client.post(f"/api/v1/imports/{uploaded['id']}/commit", headers=other)
    assert commit.status_code == 404
