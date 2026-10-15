import csv
import io
from datetime import UTC, datetime, timedelta

import pytest
from conftest import add_member, import_orders, onboard

from app.api import audit_log as audit_api
from app.core.config import get_settings
from app.core.email import SandboxEmailSender
from app.core.errors import AppError
from app.database.models import Role
from app.database.queries import users as user_queries
from app.database.session import open_session
from app.seed_demo_data import seed_company_map_data
from app.seed_reference_data import seed_reference_data
from app.services import audit_log as audit_service
from app.services import supplier_messages as message_service

SHIP = (datetime.now(UTC).date() + timedelta(days=60)).isoformat()
# PO-1: Binh Phu Wood has no plot geolocation (exposed). PO-2: An Cuong Wood has it all (clear).
ORDERS = (
    "id,product,supplier,destination,value,shipDate,hsCode\n"
    f'PO-1,Oak dining table,Binh Phu Wood,"Rotterdam, NL",48100,{SHIP},9403.60\n'
    f'PO-2,Oak dining table,An Cuong Wood,"Rotterdam, NL",30000,{SHIP},9403.60\n'
)


def good_draft(prompt, file):
    return {
        "subject": "PO-1: plot geolocation needed",
        "body": "Dear Minh,\n\nFor order PO-1 (oak dining tables) please send the plot "
        "geolocation, required by the EU Deforestation Regulation.\n\nBest regards,\nlan",
    }


@pytest.fixture
def outbox(monkeypatch) -> SandboxEmailSender:
    sender = SandboxEmailSender()
    monkeypatch.setattr(message_service, "get_email_sender", lambda: sender)
    monkeypatch.setattr(audit_service, "get_email_sender", lambda: sender)
    return sender


@pytest.fixture
def lan(client, fake_gemini, outbox) -> dict:
    headers = onboard(client, "lan@example.com")
    with open_session() as db:
        seed_reference_data(db)
        user = user_queries.get_user_by_firebase_uid(db, "dev:lan@example.com")
        _, company = user_queries.get_user_company_membership(db, user.id)
        seed_company_map_data(db, company.id)
    import_orders(client, headers, ORDERS)
    fake_gemini.answers["supplier_message"] = good_draft
    return headers


def analyse(client, headers) -> dict[str, dict]:
    run = client.post("/api/v1/runs", headers=headers).json()["data"]
    return {r["orderId"]: r for r in run["reports"]}


def draft(client, headers, report_id, **body):
    return client.post(
        "/api/v1/supplier-messages", headers=headers, json={"reportId": report_id, **body}
    )


def test_draft_approve_and_send_once(client, lan, outbox, fake_gemini):
    report_id = analyse(client, lan)["PO-1"]["id"]
    report = client.get(f"/api/v1/reports/{report_id}", headers=lan).json()["data"]
    assert report["messageBlockedReason"] is None

    response = draft(client, lan, report_id)
    assert response.status_code == 201, response.text
    message = response.json()["data"]
    assert (message["status"], message["orderId"]) == ("draft", "PO-1")
    assert message["recipient"] == "minh@binhphuwood.example.com"  # the supplier's contact
    prompt = fake_gemini.calls[-1]["prompt"]
    assert "Plot-level geolocation" in prompt and "<data>" in prompt

    path = f"/api/v1/supplier-messages/{message['id']}"
    assert client.post(f"{path}/send", headers=lan).status_code == 409  # not approved
    approved = client.post(f"{path}/approve", headers=lan).json()["data"]
    assert approved["status"] == "approved"
    assert approved["approvedByAuthor"] is True  # one-person company: allowed, recorded

    sent = client.post(f"{path}/send", headers={**lan, "Idempotency-Key": "k1"})
    assert sent.status_code == 200, sent.text
    assert (sent.json()["data"]["status"], sent.json()["data"]["sandbox"]) == ("sent", True)
    assert client.post(f"{path}/send", headers=lan).status_code == 409
    (email,) = outbox.outbox
    assert email.to == ["minh@binhphuwood.example.com"]
    assert email.reply_to == "lan@example.com"
    assert email.subject == "PO-1: plot geolocation needed"
    assert client.patch(path, headers=lan, json={"body": "late edit"}).status_code == 409

    # Sending doesn't clear the problem.
    order = client.get("/api/v1/orders/PO-1", headers=lan).json()["data"]
    assert order["order"]["status"] == "exposed"
    listed = client.get("/api/v1/orders/PO-1/supplier-messages", headers=lan).json()["data"]
    assert [m["status"] for m in listed] == ["sent"]


def test_edits_after_approval_go_back_to_draft_and_roles_apply(client, lan):
    report_id = analyse(client, lan)["PO-1"]["id"]
    message = draft(client, lan, report_id).json()["data"]
    path = f"/api/v1/supplier-messages/{message['id']}"
    editor = add_member(client, "lan@example.com", "ed@example.com", Role.editor)
    viewer = add_member(client, "lan@example.com", "view@example.com", Role.viewer)
    assert draft(client, viewer, report_id).status_code == 403
    assert client.post(f"{path}/approve", headers=editor).status_code == 403

    client.post(f"{path}/approve", headers=lan)
    edited = client.patch(
        path,
        headers=editor,
        json={"recipient": "export@binhphuwood.example.com", "saveRecipientToSupplier": True},
    ).json()["data"]
    assert (edited["status"], edited["approvedBy"]) == ("draft", None)
    suppliers = client.get("/api/v1/trade-map", headers=lan).json()["data"]["suppliers"]
    binh_phu = next(s for s in suppliers if s["name"] == "Binh Phu Wood")
    assert binh_phu["contactEmail"] == "export@binhphuwood.example.com"

    bad = client.patch(path, headers=editor, json={"recipient": "not an address"})
    assert bad.status_code == 422
    other = onboard(client, "mai@example.com", company="Other Co")
    assert client.get(path, headers=other).status_code == 404


def test_which_reports_can_lead_to_a_message(client, lan):
    rule = {
        "text": "Problems over USD 100 go to the owner",
        "category": "Threshold",
        "when": [
            {
                "field": "estimated_cost",
                "op": "greater_than",
                "value": {"amountMinor": 10000, "currency": "USD"},
            }
        ],
        "then": {"action": "owner_review"},
    }
    client.post("/api/v1/playbook/rules", headers=lan, json=rule)
    reports = analyse(client, lan)
    exposed, clear = reports["PO-1"]["id"], reports["PO-2"]["id"]

    waiting = draft(client, lan, exposed)
    assert waiting.status_code == 409
    assert waiting.json()["error"]["message"] == "Waiting for the owner's review."
    assert draft(client, lan, clear).json()["error"]["message"].startswith("Nothing to ask")

    editor = add_member(client, "lan@example.com", "ed@example.com", Role.editor)
    review = f"/api/v1/reports/{exposed}/review"
    assert client.post(review, headers=editor, json={"note": "ok"}).status_code == 403
    reviewed = client.post(review, headers=lan, json={"note": "Ask them today."})
    assert reviewed.status_code == 200, reviewed.text
    data = reviewed.json()["data"]
    assert data["review"]["note"] == "Ask them today."
    assert data["messageBlockedReason"] is None
    assert client.post(review, headers=lan, json={}).status_code == 409
    assert client.post(f"/api/v1/reports/{clear}/review", headers=lan, json={}).status_code == 409
    assert draft(client, lan, exposed).status_code == 201

    # A newer analysis of the order replaces the old report.
    analyse(client, lan)
    stale = draft(client, lan, exposed)
    assert stale.json()["error"]["message"].startswith("A newer analysis")


def test_ai_drafts_are_checked(client, lan, fake_gemini):
    report_id = analyse(client, lan)["PO-1"]["id"]
    fake_gemini.answers["supplier_message"] = lambda p, f: {"subject": "Hello", "body": "Hi."}
    assert draft(client, lan, report_id).status_code == 503  # doesn't name the order
    fake_gemini.answers["supplier_message"] = lambda p, f: {
        "subject": "PO-1",
        "body": "See https://evil.example.com/login for PO-1.",
    }
    assert draft(client, lan, report_id).status_code == 503  # a link the report doesn't cite


def test_a_refused_send_is_failed_and_can_be_sent_again(client, lan, outbox, monkeypatch):
    report_id = analyse(client, lan)["PO-1"]["id"]
    message = draft(client, lan, report_id).json()["data"]
    path = f"/api/v1/supplier-messages/{message['id']}"
    client.post(f"{path}/approve", headers=lan)

    class Refusing:
        def send_email(self, email, idempotency_key=None):
            raise AppError(422, "email_rejected", "The email service refused this message.")

    monkeypatch.setattr(message_service, "get_email_sender", lambda: Refusing())
    assert client.post(f"{path}/send", headers=lan).status_code == 422
    failed = client.get(path, headers=lan).json()["data"]
    assert (failed["status"], failed["error"]) == (
        "failed",
        "The email service refused this message.",
    )
    monkeypatch.setattr(message_service, "get_email_sender", lambda: outbox)
    assert client.post(f"{path}/send", headers=lan).json()["data"]["status"] == "sent"


def test_report_feedback(client, lan):
    report_id = analyse(client, lan)["PO-1"]["id"]
    path = f"/api/v1/reports/{report_id}/feedback"
    viewer = add_member(client, "lan@example.com", "view@example.com", Role.viewer)
    client.post(path, headers=lan, json={"useful": False, "note": "Wrong supplier"})
    client.post(path, headers=lan, json={"useful": True})  # replaces Lan's verdict
    counts = client.post(path, headers=viewer, json={"useful": True}).json()["data"]
    assert (counts["useful"], counts["notUseful"], counts["mine"]) == (2, 0, True)
    report = client.get(f"/api/v1/reports/{report_id}", headers=lan).json()["data"]
    assert report["feedback"]["useful"] == 2


def test_audit_log_is_for_owners_and_pages(client, lan):
    analyse(client, lan)
    editor = add_member(client, "lan@example.com", "ed@example.com", Role.editor)
    assert client.get("/api/v1/audit-events", headers=editor).status_code == 403
    first = client.get("/api/v1/audit-events?limit=1", headers=lan).json()
    assert first["data"][0]["action"] == "analysis.run_completed"
    assert first["data"][0]["user"]["email"] == "lan@example.com"
    second = client.get(
        f"/api/v1/audit-events?limit=50&cursor={first['meta']['nextCursor']}", headers=lan
    ).json()
    assert first["data"][0]["id"] not in {e["id"] for e in second["data"]}
    imports = client.get("/api/v1/audit-events?objectType=import", headers=lan).json()["data"]
    assert imports and {e["objectType"] for e in imports} == {"import"}
    other = onboard(client, "mai@example.com", company="Other Co")
    assert all(
        e["user"] is None or e["user"]["email"] == "mai@example.com"
        for e in client.get("/api/v1/audit-events", headers=other).json()["data"]
    )


def test_audit_log_downloads_as_csv(client, lan):
    analyse(client, lan)
    editor = add_member(client, "lan@example.com", "ed@example.com", Role.editor)
    assert client.get("/api/v1/audit-events/export", headers=editor).status_code == 403
    response = client.get("/api/v1/audit-events/export", headers=lan)
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/csv")
    assert 'attachment; filename="exportmate-activity-' in response.headers["content-disposition"]
    rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"))))
    assert rows[0][:4] == ["time_utc", "person", "email", "action"]
    every = client.get("/api/v1/audit-events?limit=200", headers=lan).json()["data"]
    assert [row[3] for row in rows[1:]] == [e["action"] for e in every]
    assert rows[1][2] == "lan@example.com"

    imports = client.get("/api/v1/audit-events/export?objectType=import", headers=lan)
    assert {row[4] for row in csv.reader(io.StringIO(imports.text))} - {"object_type"} == {"import"}


def test_csv_cells_that_look_like_formulas_open_as_text():
    assert audit_service._csv_cell("=HYPERLINK(1)") == "'=HYPERLINK(1)"
    assert audit_service._csv_cell("-1") == "'-1"
    assert audit_service._csv_cell("Ask them today.") == "Ask them today."


def test_contact_form(client, outbox, monkeypatch):
    audit_api.contact_limiter._hits.clear()
    message = {"name": "Hoa", "email": "hoa@example.com", "message": "Can you cover rattan?"}
    assert client.post("/api/v1/contact", json=message).status_code == 503  # no inbox set

    settings = get_settings().model_copy(update={"contact_inbox": "team@example.com"})
    monkeypatch.setattr(audit_service, "get_settings", lambda: settings)
    response = client.post("/api/v1/contact", json={**message, "company": "Rattan Co"})
    assert response.status_code == 202, response.text
    (email,) = outbox.outbox
    assert (email.to, email.reply_to) == (["team@example.com"], "hoa@example.com")
    assert email.subject == "ExportMate contact: Hoa (Rattan Co)"

    assert (
        client.post("/api/v1/contact", json={**message, "website": "spam.example"}).status_code
        == 202
    )
    assert len(outbox.outbox) == 1  # the bot's message was dropped
    assert client.post("/api/v1/contact", json={**message, "email": "nope"}).status_code == 422
    for _ in range(3):
        client.post("/api/v1/contact", json=message)
    assert client.post("/api/v1/contact", json=message).status_code == 429


def test_supplier_contact_fields(client, lan):
    body = {"name": "Kampot Timber", "contactName": "Sokha", "contactEmail": "sokha@kampot.example"}
    created = client.post("/api/v1/suppliers", headers=lan, json=body)
    assert created.status_code == 201, created.text
    assert created.json()["data"]["contactEmail"] == "sokha@kampot.example"
    bad = client.post(
        "/api/v1/suppliers", headers=lan, json={**body, "name": "X", "contactEmail": "no"}
    )
    assert bad.status_code == 422
