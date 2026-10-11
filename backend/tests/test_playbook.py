from conftest import add_member, onboard
from sqlalchemy import select

from app.database.models import AuditEvent, PlaybookRevision, Role
from app.database.session import open_session


def test_rule_lifecycle_creates_revisions(client):
    headers = onboard(client, "lan@example.com")
    assert client.get("/api/v1/playbook/rules", headers=headers).json() == {
        "data": [],
        "meta": {"revision": 0},
    }

    created = client.post(
        "/api/v1/playbook/rules",
        headers=headers,
        json={"text": "Flag margins below 8%.", "category": "Threshold"},
    ).json()
    rule_id = created["data"]["id"]
    assert created["meta"]["revision"] == 1
    assert created["data"]["enabled"] is True

    toggled = client.patch(
        f"/api/v1/playbook/rules/{rule_id}", headers=headers, json={"enabled": False}
    ).json()
    assert toggled["data"]["enabled"] is False
    assert toggled["meta"]["revision"] == 2

    deleted = client.delete(f"/api/v1/playbook/rules/{rule_id}", headers=headers).json()
    assert deleted["meta"]["revision"] == 3
    assert client.get("/api/v1/playbook/rules", headers=headers).json()["data"] == []

    with open_session() as db:
        snapshots = db.scalars(select(PlaybookRevision).order_by(PlaybookRevision.revision)).all()
        assert [len(s.rules) for s in snapshots] == [1, 1, 0]
        assert snapshots[1].rules[0]["enabled"] is False
        actions = db.scalars(select(AuditEvent.action).order_by(AuditEvent.created_at)).all()
        assert actions[-3:] == [
            "playbook.rule_created",
            "playbook.rule_updated",
            "playbook.rule_deleted",
        ]


def test_rule_validation(client):
    headers = onboard(client, "lan@example.com")
    response = client.post(
        "/api/v1/playbook/rules", headers=headers, json={"text": "", "category": "Magic"}
    )
    assert response.status_code == 422
    assert set(response.json()["error"]["fieldErrors"]) == {"text", "category"}


def test_viewer_reads_but_cannot_change(client):
    owner = onboard(client, "lan@example.com")
    client.post(
        "/api/v1/playbook/rules", headers=owner, json={"text": "Rule", "category": "Policy"}
    )
    viewer = add_member(client, "lan@example.com", "view@example.com", Role.viewer)
    assert len(client.get("/api/v1/playbook/rules", headers=viewer).json()["data"]) == 1
    response = client.post(
        "/api/v1/playbook/rules", headers=viewer, json={"text": "Mine", "category": "Policy"}
    )
    assert response.status_code == 403


def test_other_company_cannot_touch_rule(client):
    owner = onboard(client, "lan@example.com")
    other = onboard(client, "mai@example.com", company="Other Co")
    rule = client.post(
        "/api/v1/playbook/rules", headers=owner, json={"text": "Rule", "category": "Policy"}
    ).json()["data"]
    path = f"/api/v1/playbook/rules/{rule['id']}"
    assert client.patch(path, headers=other, json={"enabled": False}).status_code == 404
    assert client.delete(path, headers=other).status_code == 404
