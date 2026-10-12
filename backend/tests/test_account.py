import pytest
from conftest import add_member, auth_header, onboard

from app.database.models import Role


def test_health_needs_no_token(client):
    response = client.get("/api/v1/health")
    assert response.json() == {"data": {"status": "ok"}, "meta": {}}


def test_missing_token_is_401_with_error_shape(client):
    response = client.get("/api/v1/me", headers={"X-Request-ID": "req-123"})
    assert response.status_code == 401
    assert response.headers["X-Request-ID"] == "req-123"
    assert response.json() == {
        "error": {
            "code": "unauthenticated",
            "message": "Sign in required.",
            "fieldErrors": {},
            "requestId": "req-123",
        }
    }


def test_unverified_email_is_403(client):
    response = client.get(
        "/api/v1/me", headers={"Authorization": "Bearer dev-unverified:a@example.com"}
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "email_not_verified"


def test_new_user_is_not_onboarded(client):
    response = client.get("/api/v1/me", headers=auth_header("lan@example.com"))
    data = response.json()["data"]
    assert data["user"]["email"] == "lan@example.com"
    assert data["onboarded"] is False
    assert data["company"] is None


def test_company_routes_need_onboarding(client):
    response = client.get("/api/v1/orders", headers=auth_header("lan@example.com"))
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "onboarding_required"


def test_onboarding_makes_user_owner_once(client):
    headers = onboard(client, "lan@example.com")
    data = client.get("/api/v1/me", headers=headers).json()["data"]
    assert data["role"] == "owner"
    assert data["company"]["name"] == "Binh Duong Wood Co."
    assert data["company"]["currency"] == "USD"

    again = client.post(
        "/api/v1/onboarding",
        headers=headers,
        json={
            "companyName": "Other",
            "businessRole": "Manufacturer",
            "origin": "Vietnam",
            "destination": "Japan",
            "description": "Another company.",
        },
    )
    assert again.status_code == 409


def test_onboarding_validates_input(client):
    response = client.post(
        "/api/v1/onboarding",
        headers=auth_header("lan@example.com"),
        json={"companyName": "", "businessRole": "Pirate", "origin": "Vietnam"},
    )
    assert response.status_code == 422
    fields = response.json()["error"]["fieldErrors"]
    assert set(fields) == {"companyName", "businessRole", "destination", "description"}


def test_update_profile_and_company(client):
    headers = onboard(client, "lan@example.com")
    profile = client.patch("/api/v1/me", headers=headers, json={"name": "Lan", "digest": False})
    assert profile.json()["data"]["user"]["name"] == "Lan"
    assert profile.json()["data"]["user"]["digest"] is False

    company = client.patch("/api/v1/company", headers=headers, json={"destination": "Japan"})
    assert company.json()["data"]["destination"] == "Japan"


def test_trade_route_set_at_onboarding_and_edited_after(client):
    headers = auth_header("lan@example.com")
    response = client.post(
        "/api/v1/onboarding",
        headers=headers,
        json={
            "companyName": "Binh Duong Wood Co.",
            "businessRole": "Manufacturer",
            "origin": "Vietnam",
            "transit": [" Singapore "],
            "destination": "European Union",
            "description": "Plywood maker.",
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["data"]["company"]["transit"] == ["Singapore"]

    changed = client.patch(
        "/api/v1/company", headers=headers, json={"transit": ["Malaysia", "Sri Lanka"]}
    )
    assert changed.json()["data"]["transit"] == ["Malaysia", "Sri Lanka"]
    direct = client.patch("/api/v1/company", headers=headers, json={"transit": []})
    assert direct.json()["data"]["transit"] == []
    untouched = client.patch("/api/v1/company", headers=headers, json={"name": "BDW"})
    assert untouched.json()["data"]["transit"] == []


def test_onboarding_without_transit_is_direct(client):
    headers = onboard(client, "lan@example.com")
    assert client.get("/api/v1/me", headers=headers).json()["data"]["company"]["transit"] == []


@pytest.mark.parametrize("transit", [None, ["  "], ["A", "B", "C", "D"], ["x" * 101]])
def test_transit_is_validated(client, transit):
    headers = onboard(client, "lan@example.com")
    response = client.patch("/api/v1/company", headers=headers, json={"transit": transit})
    assert response.status_code == 422, transit


def test_only_owner_edits_company(client):
    onboard(client, "lan@example.com")
    editor = add_member(client, "lan@example.com", "ed@example.com", Role.editor)
    response = client.patch("/api/v1/company", headers=editor, json={"name": "Hijacked"})
    assert response.status_code == 403


def test_logout(client):
    response = client.post("/api/v1/me/logout", headers=auth_header("lan@example.com"))
    assert response.json()["data"] == {"signedOut": True}
