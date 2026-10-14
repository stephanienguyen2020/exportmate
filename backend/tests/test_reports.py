"""Reports: generating order and company reports, editing them, the PDF and emailing it."""

from datetime import date

import pytest
from conftest import add_member, import_orders, onboard
from sqlalchemy import select
from test_trade_map import MAP_CSV, seed_company

from app.api import reports as report_api
from app.core.config import get_settings
from app.core.email import SandboxEmailSender
from app.database.models import AuditEvent, Role
from app.database.session import open_session
from app.schemas.reports import ReportContent
from app.seed_reference_data import seed_reference_data
from app.services import reports as report_service

TODAY = date(2026, 10, 15)
# PO-6 ships after the US Section 232 change on 1 Jan 2027; PO-2 ships before it.
REPORT_CSV = (
    MAP_CSV + 'PO-6,Bathroom vanity,Binh Phu Wood,"Long Beach, US",20000,2027-01-10,9403.40\n'
)
NEWS = [
    {
        "articleId": "a1",
        "headline": "EU publishes EUDR guidance for plywood",
        "severity": "high",
        "why": "Geolocation checks tighten for HS 4412.",
        "publisher": "EU press",
        "url": "https://example.org/eudr",
        "publishedAt": "2026-10-10T08:00:00Z",
        "affected": [{"sku": "PLY-18", "name": "Acacia plywood 18 mm"}],
        "stockValueUsd": 41000,
        "status": "open",
    },
    {
        "articleId": "a2",
        "headline": "Freight rates ease",
        "severity": "medium",
        "publishedAt": "2026-10-01T08:00:00Z",
        "affected": [],
        "status": "open",
    },
    {"articleId": "a3", "headline": "Low news", "severity": "low", "publishedAt": "2026-10-12"},
    {"articleId": "a4", "headline": "Too old", "severity": "high", "publishedAt": "2026-01-01"},
]


@pytest.fixture
def reference() -> None:
    with open_session() as db:
        seed_reference_data(db)


@pytest.fixture(autouse=True)
def fixed_world(monkeypatch: pytest.MonkeyPatch) -> dict:
    """Today is fixed (the seed's dates don't move) and News watch answers with NEWS."""
    calls: dict = {"news": NEWS, "auth": []}

    def fake_news(authorization):
        calls["auth"].append(authorization)
        return calls["news"]

    monkeypatch.setattr(report_service, "today_utc", lambda: TODAY)
    monkeypatch.setattr(report_service, "fetch_news_alerts", fake_news)
    report_api.report_email_limiter._hits.clear()
    return calls


@pytest.fixture
def outbox(monkeypatch: pytest.MonkeyPatch) -> SandboxEmailSender:
    sender = SandboxEmailSender()
    monkeypatch.setattr(report_service, "get_email_sender", lambda: sender)
    return sender


@pytest.fixture
def lan(client, reference) -> dict:
    headers = onboard(client, "lan@example.com")
    seed_company("lan@example.com")
    import_orders(client, headers, REPORT_CSV)
    return headers


def create(client, headers, **body) -> dict:
    response = client.post("/api/v1/report-drafts", headers=headers, json=body)
    assert response.status_code == 201, response.text
    return response.json()["data"]


def section(content: dict, section_id: str) -> dict:
    return next(s for s in content["sections"] if s["id"] == section_id)


def rows(content: dict, section_id: str) -> dict[str, list[str]]:
    return {r["id"]: r["cells"] for r in section(content, section_id)["rows"]}


def test_order_report_lists_checks_sources_and_csv_row(client, lan):
    report = create(client, lan, kind="order", orderId="PO-1")
    content = report["content"]
    assert report["kind"] == "order" and report["scope"] == {"orderId": "PO-1"}
    assert content == report["original"]
    assert report["edits"] == {
        "header": False,
        "sections": 0,
        "rowsEdited": 0,
        "rowsAdded": 0,
        "rowsRemoved": 0,
    }
    assert [s["id"] for s in content["sections"]] == ["order", "checklist", "sources", "origin"]
    checklist = section(content, "checklist")["rows"]
    geolocation = next(r for r in checklist if r["id"] == "check-geolocation")
    assert geolocation["cells"][1] == "Missing" and geolocation["tone"] == "gap"
    assert "1 gap: Plot-level geolocation" in content["summary"]
    # Every [n] in the checklist resolves to a source row.
    refs = {r["cells"][3] for r in checklist}
    assert refs == {r[0] for r in rows(content, "sources").values()}
    assert rows(content, "origin")["csv-0"] == ["id", "PO-1"]

    preview = client.get(f"/api/v1/report-drafts/{report['id']}/pdf", headers=lan)
    assert preview.status_code == 200
    assert preview.content.startswith(b"%PDF-")
    assert preview.headers["content-disposition"].startswith("inline;")
    saved = client.get(f"/api/v1/report-drafts/{report['id']}/pdf?download=true", headers=lan)
    assert saved.headers["content-disposition"].startswith("attachment;")


def test_company_report_covers_what_is_happening_and_what_it_affects(client, lan, fixed_world):
    report = create(client, lan, kind="company", days=90)
    content = report["content"]
    assert report["scope"] == {"days": 90}
    assert fixed_world["auth"] == ["Bearer dev:lan@example.com"]
    assert [s["id"] for s in content["sections"]] == [
        "glance",
        "changes",
        "news",
        "floods",
        "versions",
        "orders",
        "suppliers",
        "sources",
    ]

    changes = rows(content, "changes")
    tariff = changes["change-US-tariff-changes"]
    assert tariff[0] == "01 Jan 2027" and tariff[4] == "PO-6"

    # High first, low and old alerts left out.
    assert [r["cells"][1] for r in section(content, "news")["rows"]] == [
        "EU publishes EUDR guidance for plywood",
        "Freight rates ease",
    ]
    assert section(content, "news")["rows"][0]["tone"] == "gap"
    assert section(content, "news")["rows"][0]["cells"][5] == "EU press\nhttps://example.org/eudr"

    assert section(content, "floods")["rows"], "the sample flood is near a demo supplier"
    assert section(content, "versions")["rows"], "the seed added official texts just now"

    gaps = rows(content, "orders")
    assert set(gaps) == {"order-PO-1", "order-PO-2", "order-PO-6"}
    assert "Plot-level geolocation: Missing" in gaps["order-PO-1"][4]
    assert "Wrong standard" in gaps["order-PO-2"][4]
    suppliers = rows(content, "suppliers")
    assert "PO-1" in suppliers["supplier-binh phu wood"][2]
    # Dong Nai Veneer has no document record: listed so someone asks for one.
    assert suppliers["supplier-dong nai veneer"][1].startswith("No document record")

    glance = rows(content, "glance")
    assert glance["glance-gaps"][1].startswith("3 orders · ")
    assert glance["glance-changes"][1].endswith("affecting 1 open order")
    assert glance["glance-news"][1] == "2 high or medium (1 high)"
    assert "Between 17 Jul 2026 and 13 Jan 2027" in content["summary"]

    pdf = client.get(f"/api/v1/report-drafts/{report['id']}/pdf", headers=lan)
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF-")


def test_company_report_says_when_news_watch_is_down(client, lan, fixed_world):
    fixed_world["news"] = None
    content = create(client, lan, kind="company")["content"]
    news = section(content, "news")
    assert news["rows"] == []
    assert "could not be reached" in news["empty"]
    assert rows(content, "glance")["glance-news"][1] == "News watch unavailable"


def test_everything_can_be_edited_and_the_edits_are_counted(client, lan):
    report = create(client, lan, kind="order", orderId="PO-1")
    content = report["content"]
    content["title"] = "PO-1 for our buyer"
    checklist = section(content, "checklist")
    checklist["note"] = "Reworded note."
    checklist["rows"][0]["cells"][2] = "Dossier renewed last week."
    checklist["rows"][1]["included"] = False
    checklist["rows"].append(
        {"id": "added-1", "cells": ["Buyer audit", "Check", "Booked for 20 Oct.", ""]}
    )
    section(content, "origin")["included"] = False

    response = client.patch(
        f"/api/v1/report-drafts/{report['id']}", headers=lan, json={"content": content}
    )
    assert response.status_code == 200, response.text
    updated = response.json()["data"]
    assert updated["content"]["title"] == "PO-1 for our buyer"
    assert updated["original"]["title"] != "PO-1 for our buyer"
    assert updated["edits"] == {
        "header": True,
        "sections": 1,
        "rowsEdited": 1,
        "rowsAdded": 1,
        "rowsRemoved": 2,  # one line and one section left out
    }
    pdf = client.get(f"/api/v1/report-drafts/{report['id']}/pdf", headers=lan)
    assert pdf.status_code == 200

    # The list shows the edited title.
    listed = client.get("/api/v1/report-drafts", headers=lan).json()["data"]
    assert [r["title"] for r in listed] == ["PO-1 for our buyer"]


def test_compare_report_marks_only_real_changes():
    original = ReportContent.model_validate(
        {
            "title": "T",
            "sections": [
                {
                    "id": "s",
                    "layout": "table",
                    "heading": "H",
                    "columns": ["A", "B"],
                    "widths": [1, 1],
                    "rows": [
                        {"id": "r1", "cells": ["1", "2"]},
                        {"id": "r2", "cells": ["3", "4"], "included": False},
                    ],
                }
            ],
        }
    )
    edited = original.model_copy(deep=True)
    edited.sections[0].rows[1].cells = ["changed", "but left out"]  # not shown: not an edit
    edited.sections[0].rows.append(
        edited.sections[0].rows[0].model_copy(update={"id": "new", "included": False})
    )
    summary, per_section = report_service.compare_report(original, edited)
    assert not summary.has_edits
    assert not per_section["s"].has_edits


@pytest.mark.parametrize(
    ("change", "code"),
    [
        (lambda c: c["sections"].pop(), "invalid_report"),
        (lambda c: section(c, "checklist")["rows"].pop(0), "invalid_report"),
        (lambda c: section(c, "checklist").update(widths=[1, 1, 1, 1]), "invalid_report"),
        (lambda c: section(c, "checklist").update(layout="facts"), "invalid_report"),
        (lambda c: section(c, "checklist")["rows"][0]["cells"].pop(), "invalid_input"),
        (lambda c: c.update(title=""), "invalid_input"),
    ],
)
def test_report_structure_cannot_change(client, lan, change, code):
    report = create(client, lan, kind="order", orderId="PO-1")
    content = report["content"]
    change(content)
    response = client.patch(
        f"/api/v1/report-drafts/{report['id']}", headers=lan, json={"content": content}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == code


def test_drafts_belong_to_their_author(client, lan):
    report = create(client, lan, kind="order", orderId="PO-1")
    colleague = add_member(client, "lan@example.com", "minh@example.com", Role.editor)
    assert client.get(f"/api/v1/report-drafts/{report['id']}", headers=colleague).status_code == 404
    assert client.get("/api/v1/report-drafts", headers=colleague).json()["data"] == []

    other = onboard(client, "an@example.com", "Other Co.")
    assert client.get(f"/api/v1/report-drafts/{report['id']}/pdf", headers=other).status_code == 404
    response = client.post(
        "/api/v1/report-drafts", headers=other, json={"kind": "order", "orderId": "PO-1"}
    )
    assert response.status_code == 404
    response = client.post("/api/v1/report-drafts", headers=other, json={"kind": "order"})
    assert response.status_code == 422


def test_editor_emails_the_report_once_and_it_locks(client, lan, outbox):
    report = create(client, lan, kind="order", orderId="PO-1")
    content = report["content"]
    content["summary"] = "Edited summary for the buyer."
    client.patch(f"/api/v1/report-drafts/{report['id']}", headers=lan, json={"content": content})

    response = client.post(
        f"/api/v1/report-drafts/{report['id']}/email",
        headers=lan,
        json={
            "to": [" Buyer@Example.com ", "buyer@example.com", "qa@example.org"],
            "message": "Hi <b>Anna</b>",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"]["recipients"] == ["Buyer@Example.com", "qa@example.org"]
    assert response.json()["data"]["sandbox"] is True

    [sent] = outbox.outbox
    assert sent.reply_to == "lan@example.com"
    assert sent.subject.startswith("Binh Duong Wood Co.: PO-1 · ")
    [attachment] = sent.attachments
    assert attachment.filename.startswith("exportmate-PO-1-") and attachment.content[:5] == b"%PDF-"
    assert "&lt;b&gt;Anna&lt;/b&gt;" in sent.html and "<b>Anna</b>" not in sent.html
    assert "Edited summary for the buyer." in sent.text
    assert "contains edits by lan" in sent.text

    after = client.get(f"/api/v1/report-drafts/{report['id']}", headers=lan).json()["data"]
    assert after["sentTo"] == ["Buyer@Example.com", "qa@example.org"] and after["sentAt"]
    again = client.post(
        f"/api/v1/report-drafts/{report['id']}/email", headers=lan, json={"to": ["x@example.com"]}
    )
    assert again.status_code == 409
    edit = client.patch(
        f"/api/v1/report-drafts/{report['id']}", headers=lan, json={"content": content}
    )
    assert edit.status_code == 409
    assert len(outbox.outbox) == 1

    with open_session() as db:
        event = db.scalar(select(AuditEvent).where(AuditEvent.action == "report.emailed"))
    assert event.object_id == report["id"]
    assert event.data["recipients"] == ["Buyer@Example.com", "qa@example.org"]
    assert event.data["edits"]["header"] is True


def test_viewers_preview_but_cannot_email(client, lan, outbox):
    viewer = add_member(client, "lan@example.com", "viewer@example.com", Role.viewer)
    report = create(client, viewer, kind="order", orderId="PO-1")
    assert (
        client.get(f"/api/v1/report-drafts/{report['id']}/pdf", headers=viewer).status_code == 200
    )
    response = client.post(
        f"/api/v1/report-drafts/{report['id']}/email",
        headers=viewer,
        json={"to": ["a@example.com"]},
    )
    assert response.status_code == 403
    assert outbox.outbox == []


@pytest.mark.parametrize(
    "to",
    [
        [],
        ["not-an-address"],
        ["Anna <anna@example.com>"],
        ["a@example.com, b@example.com"],
        [f"user{i}@example.com" for i in range(6)],
    ],
)
def test_bad_recipients_are_422(client, lan, outbox, to):
    report = create(client, lan, kind="order", orderId="PO-1")
    response = client.post(
        f"/api/v1/report-drafts/{report['id']}/email", headers=lan, json={"to": to}
    )
    assert response.status_code == 422
    assert "to" in response.json()["error"]["fieldErrors"]
    assert outbox.outbox == []


def test_report_emails_are_rate_limited(client, lan, outbox, monkeypatch):
    first = create(client, lan, kind="order", orderId="PO-1")
    second = create(client, lan, kind="order", orderId="PO-2")
    monkeypatch.setenv("REPORT_EMAILS_PER_HOUR", "1")
    get_settings.cache_clear()
    try:
        ok = client.post(
            f"/api/v1/report-drafts/{first['id']}/email",
            headers=lan,
            json={"to": ["a@example.com"]},
        )
        limited = client.post(
            f"/api/v1/report-drafts/{second['id']}/email",
            headers=lan,
            json={"to": ["a@example.com"]},
        )
    finally:
        monkeypatch.delenv("REPORT_EMAILS_PER_HOUR")
        get_settings.cache_clear()
    assert ok.status_code == 200
    assert limited.status_code == 429
    assert len(outbox.outbox) == 1


def test_report_filename_is_safe():
    assert report_service.report_filename("PO-2291 · Acacia") == "exportmate-PO-2291-Acacia.pdf"
    assert report_service.report_filename('a"/\\b') == "exportmate-a-b.pdf"
    assert report_service.report_filename("···") == "exportmate-report.pdf"


def test_a_trailing_url_renders_as_a_link():
    assert report_service.cell_link("HKTDC Research\nhttps://news.example/a?b=1") == (
        "HKTDC Research ›",
        "https://news.example/a?b=1",
    )
    assert report_service.cell_link("See https://x.example") == ("See https://x.example", None)
    assert report_service.cell_link("\nhttps://x.example") == ("\nhttps://x.example", None)
