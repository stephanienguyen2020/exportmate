import pytest
from pydantic import ValidationError

from app.core.config import Settings


def test_firebase_sign_in_needs_its_project_named(monkeypatch):
    """No project is assumed: a run without FIREBASE_PROJECT_ID must not quietly use a real one."""
    monkeypatch.delenv("FIREBASE_PROJECT_ID", raising=False)
    with pytest.raises(ValidationError, match="FIREBASE_PROJECT_ID"):
        Settings(_env_file=None, auth_mode="firebase")
    assert Settings(_env_file=None, auth_mode="firebase", firebase_project_id="p").auth_mode
    assert Settings(_env_file=None, auth_mode="dev").firebase_project_id is None
