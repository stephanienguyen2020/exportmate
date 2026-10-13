"""Upload rate limit, currency codes, stale import cleanup and the cached revocation check."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from conftest import VALID_CSV, auth_header, import_orders, onboard, upload_csv
from sqlalchemy import update

from app.core import auth
from app.core.config import get_settings
from app.core.errors import AppError
from app.database.models import Import
from app.database.session import open_session
from app.services.order_imports import delete_stale_imports


def test_uploads_are_rate_limited_per_user(client, monkeypatch):
    headers = onboard(client, "lan@example.com")
    monkeypatch.setenv("IMPORT_UPLOADS_PER_HOUR", "2")
    get_settings.cache_clear()
    try:
        assert upload_csv(client, headers, VALID_CSV).status_code == 201
        assert upload_csv(client, headers, VALID_CSV).status_code == 201
        third = upload_csv(client, headers, VALID_CSV)
        # Another user is counted separately.
        other = upload_csv(client, onboard(client, "minh@example.com", "Other Co."), VALID_CSV)
    finally:
        monkeypatch.delenv("IMPORT_UPLOADS_PER_HOUR")
        get_settings.cache_clear()
    assert third.status_code == 429
    assert third.json()["error"]["code"] == "rate_limited"
    assert other.status_code == 201


def test_csv_and_onboarding_accept_only_iso_currencies(client):
    headers = onboard(client, "lan@example.com")
    csv = (
        "id,product,supplier,destination,value,shipDate,hsCode,currency\n"
        "PO-1,Plywood,Binh Phu,NL,100,2026-10-27,4412.33,jpy\n"
        "PO-2,Plywood,Binh Phu,NL,100,2026-10-27,4412.33,UDS\n"
    )
    data = upload_csv(client, headers, csv).json()["data"]
    assert [e["row"] for e in data["errors"]] == [3]
    assert data["errors"][0]["field"] == "currency"

    response = client.post(
        "/api/v1/onboarding",
        headers=auth_header("minh@example.com"),
        json={
            "companyName": "Other Co.",
            "businessRole": "Manufacturer",
            "origin": "Vietnam",
            "destination": "Japan",
            "currency": "XYZ",
            "description": "Furniture maker.",
        },
    )
    assert response.status_code == 422
    assert "currency" in response.json()["error"]["fieldErrors"]


def test_cleanup_removes_only_old_uncommitted_imports(client):
    headers = onboard(client, "lan@example.com")
    committed = import_orders(client, headers)
    stale = upload_csv(client, headers, VALID_CSV + "PO-9,P,S,D,abc,2026-10-27,4412.33\n").json()
    fresh = upload_csv(client, headers, VALID_CSV.replace("PO-", "NEW-")).json()
    old = datetime.now(UTC) - timedelta(days=40)
    with open_session() as db:
        db.execute(
            update(Import)
            .where(Import.id.in_([committed["id"], stale["data"]["id"]]))
            .values(created_at=old)
        )
        db.commit()
        assert delete_stale_imports(db, timedelta(days=30)) == 1

    def status(import_id):
        return client.get(f"/api/v1/imports/{import_id}", headers=headers).status_code

    assert status(stale["data"]["id"]) == 404
    assert status(committed["id"]) == 200
    assert status(fresh["data"]["id"]) == 200
    # Orders still cite the committed import's rows.
    detail = client.get("/api/v1/orders/PO-1", headers=headers).json()["data"]
    assert detail["source"]["importId"] == committed["id"]


def test_revocation_check_is_cached_and_cleared_on_sign_out(monkeypatch):
    calls = []
    state = {"valid_after_ms": 0}

    def get_user(uid, app=None):
        calls.append(uid)
        return SimpleNamespace(tokens_valid_after_timestamp=state["valid_after_ms"], disabled=False)

    monkeypatch.setattr(auth, "_firebase_app", lambda: None)
    monkeypatch.setattr(
        auth.fb_auth,
        "verify_id_token",
        lambda token, app=None: {
            "uid": "u1",
            "iat": 1_000,
            "email": "a@b.c",
            "email_verified": True,
        },
    )
    monkeypatch.setattr(auth.fb_auth, "get_user", get_user)
    monkeypatch.setattr(auth.fb_auth, "revoke_refresh_tokens", lambda uid, app=None: None)
    monkeypatch.setattr(auth, "get_settings", lambda: SimpleNamespace(auth_mode="firebase"))
    auth._revocations.clear()

    assert auth.verify_token("t").uid == "u1"
    assert auth.verify_token("t").uid == "u1"
    assert calls == ["u1"]  # the second request used the cached answer

    # Signing out everywhere revokes tokens issued before now and forgets the cached answer.
    state["valid_after_ms"] = 2_000_000
    auth.revoke_sessions("u1")
    with pytest.raises(AppError) as error:
        auth.verify_token("t")
    assert error.value.code == "session_revoked"
    assert calls == ["u1", "u1"]
    auth._revocations.clear()
