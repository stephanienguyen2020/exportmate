"""The Gemini client itself. conftest replaces `generate_json` and `embed_texts` for every test,
so the real ones are imported here, when the module loads, before that happens."""

from types import SimpleNamespace

import pytest
from google.auth.exceptions import DefaultCredentialsError
from pydantic import BaseModel

from app.core import gemini
from app.core.errors import AppError
from app.core.gemini import embed_texts, generate_json


class Answer(BaseModel):
    text: str


def fail_without_credentials(**_):
    raise DefaultCredentialsError("Your default credentials were not found.")


@pytest.mark.parametrize(
    "ask",
    [
        lambda: generate_json("test_task", "Say hello.", Answer),
        lambda: embed_texts(["wooden chairs"], "RETRIEVAL_QUERY"),
    ],
    ids=["generate_json", "embed_texts"],
)
def test_missing_google_credentials_mean_ai_is_not_configured(monkeypatch, ask):
    client = SimpleNamespace(
        models=SimpleNamespace(
            generate_content=fail_without_credentials, embed_content=fail_without_credentials
        )
    )
    monkeypatch.setattr(gemini, "_client", lambda: client)
    with pytest.raises(AppError) as raised:
        ask()
    assert (raised.value.status, raised.value.code) == (503, "ai_not_configured")
