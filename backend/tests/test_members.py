from datetime import UTC, datetime, timedelta

import pytest
from conftest import VALID_CSV, add_member, auth_header, import_orders, onboard, upload_csv
from sqlalchemy import select, update

from app.core.email import SandboxEmailSender
from app.core.errors import AppError
from app.database.models import AuditEvent, CompanyInvite, Membership, Role
from app.database.session import open_session
from app.services import members as member_service

LAN = "lan@example.com"


@pytest.fixture
def outbox(monkeypatch: pytest.MonkeyPatch) -> SandboxEmailSender:
    sender = SandboxEmailSender()
    monkeypatch.setattr(member_service, "get_email_sender", lambda: sender)
    return sender


@pytest.fixture
def lan(client) -> dict:
    return onboard(client, LAN)


def invite(client, headers, email: str, role: str = "editor"):
    return client.post(
        "/api/v1/company/invites", headers=headers, json={"email": email, "role": role}
    )


def received(client, email: str) -> list[dict]:
    response = client.get("/api/v1/me/invites", headers=auth_header(email))
    assert response.status_code == 200, response.text
    return response.json()["data"]


def accept(client, email: str, invite_id: str):
    return client.post(f"/api/v1/me/invites/{invite_id}/accept", headers=auth_header(email))


def members(client, headers) -> dict[str, str]:
    response = client.get("/api/v1/company/members", headers=headers)
    assert response.status_code == 200, response.text
    return {m["email"]: m["role"] for m in response.json()["data"]}


def actions() -> list[str]:
    with open_session() as db:
        return list(db.scalars(select(AuditEvent.action).order_by(AuditEvent.created_at)))


def test_invited_person_joins_with_the_role_and_sees_the_company(client, lan, outbox):
    import_orders(client, lan)
    response = invite(client, lan, "  Minh@Example.com ", "editor")
    assert response.status_code == 201, response.text
    sent = response.json()["data"]
    assert sent["email"] == "minh@example.com"
    assert sent["role"] == "editor"
    assert sent["sandbox"] is True
    assert sent["expired"] is False
    [email] = outbox.outbox
    assert email.to == ["minh@example.com"]
    assert "Binh Duong Wood Co." in email.subject
    assert "as editor" in email.text
    assert "/#/login" in email.text
    assert email.reply_to == LAN

    # Before accepting, Minh has no company.
    minh = auth_header("minh@example.com")
    assert client.get("/api/v1/orders", headers=minh).status_code == 403
    [mine] = received(client, "minh@example.com")
    assert mine["companyName"] == "Binh Duong Wood Co."
    assert mine["role"] == "editor"
    assert mine["invitedBy"]["name"] == "lan"

    joined = accept(client, "minh@example.com", mine["id"])
    assert joined.status_code == 200, joined.text
    assert joined.json()["data"]["role"] == "editor"
    assert joined.json()["data"]["onboarded"] is True
    assert client.get("/api/v1/me", headers=minh).json()["data"]["role"] == "editor"
    assert len(client.get("/api/v1/orders", headers=minh).json()["data"]) == 2

    assert members(client, lan) == {LAN: "owner", "minh@example.com": "editor"}
    assert received(client, "minh@example.com") == []
    assert client.get("/api/v1/company/invites", headers=lan).json()["data"] == []
    assert actions()[-2:] == ["member.invited", "member.joined"]


def test_roles_decide_what_a_member_may_do(client, lan, outbox):
    viewer = add_member(client, LAN, "an@example.com", Role.viewer)
    editor = add_member(client, LAN, "binh@example.com", Role.editor)
    # Everyone sees the team; only owners see and send invitations or change roles.
    assert set(members(client, viewer)) == {LAN, "an@example.com", "binh@example.com"}
    for headers in (viewer, editor):
        assert invite(client, headers, "x@example.com").status_code == 403
        assert client.get("/api/v1/company/invites", headers=headers).status_code == 403
    with open_session() as db:
        an = db.scalar(select(Membership.user_id).where(Membership.role == Role.viewer))
    promote = client.patch(f"/api/v1/company/members/{an}", headers=editor, json={"role": "owner"})
    assert promote.status_code == 403
    assert promote.json()["error"]["code"] == "forbidden"

    # The viewer can't import; once the owner makes them an editor, they can.
    assert import_orders_status(client, viewer) == 403
    changed = client.patch(f"/api/v1/company/members/{an}", headers=lan, json={"role": "editor"})
    assert changed.status_code == 200, changed.text
    assert changed.json()["data"]["role"] == "editor"
    assert import_orders_status(client, viewer) == 201
    assert "member.role_changed" in actions()


def import_orders_status(client, headers) -> int:
    return upload_csv(client, headers, VALID_CSV).status_code


def test_company_always_keeps_an_owner(client, lan):
    me = client.get("/api/v1/company/members", headers=lan).json()["data"][0]
    assert me["you"] is True
    demote = client.patch(
        f"/api/v1/company/members/{me['userId']}", headers=lan, json={"role": "viewer"}
    )
    assert demote.status_code == 409
    assert demote.json()["error"]["code"] == "last_owner"
    leave = client.delete(f"/api/v1/company/members/{me['userId']}", headers=lan)
    assert leave.status_code == 409

    # With a second owner, the first can step down.
    add_member(client, LAN, "hoa@example.com", Role.owner)
    demote = client.patch(
        f"/api/v1/company/members/{me['userId']}", headers=lan, json={"role": "viewer"}
    )
    assert demote.status_code == 200, demote.text
    assert members(client, lan)[LAN] == "viewer"


def test_members_leave_and_owners_remove(client, lan):
    viewer = add_member(client, LAN, "an@example.com", Role.viewer)
    add_member(client, LAN, "binh@example.com", Role.editor)
    ids = {
        m["email"]: m["userId"]
        for m in client.get("/api/v1/company/members", headers=lan).json()["data"]
    }
    # A viewer can't remove someone else, but can leave.
    assert (
        client.delete(f"/api/v1/company/members/{ids['binh@example.com']}", headers=viewer)
    ).status_code == 403
    left = client.delete(f"/api/v1/company/members/{ids['an@example.com']}", headers=viewer)
    assert left.status_code == 200, left.text
    assert client.get("/api/v1/orders", headers=viewer).json()["error"]["code"] == (
        "onboarding_required"
    )
    removed = client.delete(f"/api/v1/company/members/{ids['binh@example.com']}", headers=lan)
    assert removed.status_code == 200, removed.text
    assert members(client, lan) == {LAN: "owner"}
    assert actions()[-2:] == ["member.left", "member.removed"]
    # Someone not in the company is not found.
    assert (
        client.delete(f"/api/v1/company/members/{ids['binh@example.com']}", headers=lan)
    ).status_code == 404


def test_other_companies_members_and_invites_are_out_of_reach(client, lan, outbox):
    other = onboard(client, "tuan@example.com", company="Other Co.")
    sent = invite(client, lan, "minh@example.com").json()["data"]
    tuan = client.get("/api/v1/company/members", headers=other).json()["data"][0]
    assert set(members(client, other)) == {"tuan@example.com"}
    assert client.delete(f"/api/v1/company/invites/{sent['id']}", headers=other).status_code == 404
    assert (
        client.patch(
            f"/api/v1/company/members/{tuan['userId']}", headers=lan, json={"role": "viewer"}
        ).status_code
        == 404
    )
    # Only the invited address can see or accept an invitation.
    assert received(client, "someone@example.com") == []
    assert accept(client, "someone@example.com", sent["id"]).status_code == 404


def test_reinviting_renews_and_existing_members_are_refused(client, lan, outbox):
    first = invite(client, lan, "minh@example.com", "viewer").json()["data"]
    with open_session() as db:
        db.execute(update(CompanyInvite).values(expires_at=datetime.now(UTC) - timedelta(days=1)))
        db.commit()
    [listed] = client.get("/api/v1/company/invites", headers=lan).json()["data"]
    assert listed["expired"] is True
    # An expired invitation can't be accepted, or even seen by the invitee.
    assert received(client, "minh@example.com") == []
    assert accept(client, "minh@example.com", first["id"]).status_code == 404

    again = invite(client, lan, "minh@example.com", "editor").json()["data"]
    assert again["id"] == first["id"]
    assert again["role"] == "editor"
    assert again["expired"] is False
    assert len(outbox.outbox) == 2

    assert accept(client, "minh@example.com", first["id"]).status_code == 200
    refused = invite(client, lan, "MINH@example.com")
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "already_member"
    assert invite(client, lan, "not an address").status_code == 422


def test_someone_in_a_company_must_leave_before_joining(client, lan, outbox):
    onboard(client, "tuan@example.com", company="Other Co.")
    sent = invite(client, lan, "tuan@example.com").json()["data"]
    refused = accept(client, "tuan@example.com", sent["id"])
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "already_in_company"
    # Onboarding after accepting is refused too: one company per user.
    minh_invite = invite(client, lan, "minh@example.com").json()["data"]
    assert accept(client, "minh@example.com", minh_invite["id"]).status_code == 200
    again = client.post(
        "/api/v1/onboarding",
        headers=auth_header("minh@example.com"),
        json={
            "companyName": "Minh Co.",
            "businessRole": "Manufacturer",
            "origin": "Vietnam",
            "destination": "European Union",
            "description": "Furniture.",
        },
    )
    assert again.status_code == 409


def test_revoke_and_decline(client, lan, outbox):
    revoked = invite(client, lan, "an@example.com").json()["data"]
    assert client.delete(f"/api/v1/company/invites/{revoked['id']}", headers=lan).status_code == 200
    assert received(client, "an@example.com") == []

    declined = invite(client, lan, "binh@example.com").json()["data"]
    assert (
        client.delete(
            f"/api/v1/me/invites/{declined['id']}", headers=auth_header("binh@example.com")
        ).status_code
        == 200
    )
    assert client.get("/api/v1/company/invites", headers=lan).json()["data"] == []
    assert actions() == [
        "company.created",
        "member.invited",
        "member.invite_revoked",
        "member.invited",
        "member.invite_declined",
    ]


def test_a_failed_email_saves_no_invitation(client, lan, monkeypatch):
    class FailingSender:
        def send_email(self, email, idempotency_key=None):
            raise AppError(503, "email_unavailable", "Email is unavailable. Try again later.")

    monkeypatch.setattr(member_service, "get_email_sender", lambda: FailingSender())
    assert invite(client, lan, "minh@example.com").status_code == 503
    assert client.get("/api/v1/company/invites", headers=lan).json()["data"] == []
