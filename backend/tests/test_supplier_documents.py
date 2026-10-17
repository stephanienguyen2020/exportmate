from datetime import UTC, datetime, timedelta

import pytest
from conftest import add_member, import_orders, onboard

from app.database.models import Role
from app.database.queries import users as user_queries
from app.database.session import open_session
from app.seed_demo_data import seed_company_map_data
from app.seed_reference_data import seed_reference_data

TODAY = datetime.now(UTC).date()
CERTIFICATE = b"%PDF-1.7 geolocation statement for plots in Binh Phuoc"
PHOTO = b"\xff\xd8\xff\xe0 a phone photo of a certificate"
ORDERS = (
    "id,product,supplier,destination,value,shipDate,hsCode\n"
    f'PO-1,Oak dining table,Binh Phu Wood,"Rotterdam, NL",48100,'
    f"{(TODAY + timedelta(days=60)).isoformat()},9403.60\n"
)


def read_as(**fields):
    answer = {
        "kind": "geolocation",
        "document_number": "GEO-2026-118",
        "issuer": "Binh Phuoc Forest Protection Department",
        "issued_on": "2026-09-01",
        "expires_on": (TODAY + timedelta(days=365)).isoformat(),
        "standards": [],
        "detail": "Plot coordinates for the 2026 acacia harvest, 4 plots",
        "notes": None,
        **fields,
    }
    return lambda prompt, file: answer


@pytest.fixture
def lan(client) -> tuple[dict, str]:
    headers = onboard(client, "lan@example.com")
    with open_session() as db:
        seed_reference_data(db)
        user = user_queries.get_user_by_firebase_uid(db, "dev:lan@example.com")
        _, company = user_queries.get_user_company_membership(db, user.id)
        seed_company_map_data(db, company.id)
    import_orders(client, headers, ORDERS)
    suppliers = client.get("/api/v1/trade-map", headers=headers).json()["data"]["suppliers"]
    supplier_id = next(s["id"] for s in suppliers if s["name"] == "Binh Phu Wood")
    return headers, supplier_id


def upload(client, headers, supplier_id, content=CERTIFICATE, filename="geo.pdf"):
    return client.post(
        f"/api/v1/suppliers/{supplier_id}/documents",
        headers=headers,
        files={"file": (filename, content, "application/octet-stream")},
    )


def supplier_files(file_storage) -> list[str]:
    return [p for p in file_storage.files if "/supplier-documents/" in p]


def geolocation_status(client, headers) -> str:
    order = client.get("/api/v1/trade-map", headers=headers).json()["data"]["orders"][0]
    return next(c["status"] for c in order["checks"] if c["requirementKey"] == "geolocation")


def test_uploaded_document_counts_only_once_confirmed(client, lan, fake_gemini, file_storage):
    headers, supplier_id = lan
    fake_gemini.answers["supplier_document_reading"] = read_as()
    assert geolocation_status(client, headers) == "missing"

    response = upload(client, headers, supplier_id)
    assert response.status_code == 201, response.text
    draft = response.json()["data"]
    assert draft["status"] == "draft"
    assert draft["extracted"]["documentNumber"] == "GEO-2026-118"
    assert fake_gemini.calls[0]["file"] == (CERTIFICATE, "application/pdf")
    assert [p.rsplit("/", 1)[-1] for p in supplier_files(file_storage)] == [f"{draft['id']}.pdf"]
    assert geolocation_status(client, headers) == "missing"  # not confirmed yet

    confirm = {
        "kind": "geolocation",
        "detail": draft["extracted"]["detail"],
        "documentNumber": "GEO-2026-118",
        "expiresOn": draft["extracted"]["expiresOn"],
    }
    confirmed = client.post(
        f"/api/v1/supplier-documents/{draft['id']}/confirm", headers=headers, json=confirm
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["data"]["uploadId"] == draft["id"]
    assert geolocation_status(client, headers) == "on_file"
    again = client.post(
        f"/api/v1/supplier-documents/{draft['id']}/confirm", headers=headers, json=confirm
    )
    assert again.status_code == 409


def test_a_document_expiring_before_the_ship_date_is_a_mismatch(client, lan, fake_gemini):
    headers, supplier_id = lan
    expired = (TODAY + timedelta(days=30)).isoformat()
    fake_gemini.answers["supplier_document_reading"] = read_as(expires_on=expired)
    draft = upload(client, headers, supplier_id, PHOTO, "geo.jpg").json()["data"]
    client.post(
        f"/api/v1/supplier-documents/{draft['id']}/confirm",
        headers=headers,
        json={"kind": "geolocation", "detail": "Plots", "expiresOn": expired},
    )
    assert geolocation_status(client, headers) == "mismatch"


def test_ai_answers_are_checked_and_files_validated(client, lan, fake_gemini):
    headers, supplier_id = lan
    fake_gemini.answers["supplier_document_reading"] = read_as(
        kind="passport", expires_on="15/12/2026"
    )
    draft = upload(client, headers, supplier_id).json()["data"]
    assert draft["extracted"]["kind"] is None
    assert draft["extracted"]["expiresOn"] is None
    bad_kind = client.post(
        f"/api/v1/supplier-documents/{draft['id']}/confirm",
        headers=headers,
        json={"kind": "passport", "detail": "x"},
    )
    assert bad_kind.status_code == 422

    assert upload(client, headers, supplier_id, b"not a pdf").status_code == 422
    assert upload(client, headers, supplier_id, CERTIFICATE, "geo.docx").status_code == 422
    viewer = add_member(client, "lan@example.com", "view@example.com", Role.viewer)
    assert upload(client, viewer, supplier_id).status_code == 403
    other = onboard(client, "mai@example.com", company="Other Co")
    assert upload(client, other, supplier_id).status_code == 404
    other_confirm = client.post(
        f"/api/v1/supplier-documents/{draft['id']}/confirm",
        headers=other,
        json={"kind": "geolocation", "detail": "x"},
    )
    assert other_confirm.status_code == 404


def test_nothing_is_saved_when_the_ai_fails(client, lan, file_storage):
    headers, supplier_id = lan
    assert upload(client, headers, supplier_id).status_code == 503
    assert supplier_files(file_storage) == []


def test_editing_a_supplier_keeps_typed_and_uploaded_document_fields(client, lan, fake_gemini):
    headers, supplier_id = lan
    fake_gemini.answers["supplier_document_reading"] = read_as()
    draft = upload(client, headers, supplier_id).json()["data"]
    expires = draft["extracted"]["expiresOn"]
    client.post(
        f"/api/v1/supplier-documents/{draft['id']}/confirm",
        headers=headers,
        json={
            "kind": "geolocation",
            "detail": "Plots",
            "documentNumber": "GEO-118",
            "expiresOn": expires,
        },
    )
    supplier = next(
        s
        for s in client.get("/api/v1/trade-map", headers=headers).json()["data"]["suppliers"]
        if s["id"] == supplier_id
    )
    # The edit form sends every document back, as typed fields.
    documents = [
        {k: d[k] for k in ("kind", "detail", "standards", "documentNumber", "issuer", "expiresOn")}
        for d in supplier["documents"]
    ]
    edited = client.patch(
        f"/api/v1/suppliers/{supplier_id}",
        headers=headers,
        json={"place": "Dong Xoai", "documents": documents},
    )
    assert edited.status_code == 200, edited.text
    kept = next(d for d in edited.json()["data"]["documents"] if d["kind"] == "geolocation")
    assert (kept["documentNumber"], kept["expiresOn"], kept["fromUpload"]) == (
        "GEO-118",
        expires,
        True,
    )


def test_deleting_a_supplier_deletes_its_uploaded_files(client, lan, fake_gemini, file_storage):
    headers, supplier_id = lan
    fake_gemini.answers["supplier_document_reading"] = read_as()
    assert upload(client, headers, supplier_id).status_code == 201
    assert supplier_files(file_storage)
    response = client.delete(f"/api/v1/suppliers/{supplier_id}", headers=headers)
    assert response.status_code == 200
    assert supplier_files(file_storage) == []
