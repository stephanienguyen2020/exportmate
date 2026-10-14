"""The Resend client and the News watch client, with the network replaced."""

import io
import json
import urllib.error

import pytest

from app.core import email as email_module
from app.core import news_alerts
from app.core.config import get_settings
from app.core.email import EmailAttachment, OutgoingEmail, ResendEmailSender
from app.core.errors import AppError


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def test_resend_request_carries_attachment_reply_to_and_idempotency_key(monkeypatch):
    seen = {}

    def fake_urlopen(request, timeout):
        seen["url"] = request.full_url
        seen["headers"] = dict(request.header_items())
        seen["body"] = json.loads(request.data)
        return FakeResponse(b'{"id": "re_123"}')

    monkeypatch.setattr(email_module.urllib.request, "urlopen", fake_urlopen)
    sender = ResendEmailSender("re_key", "ExportMate <reports@exportmate.app>")
    receipt = sender.send_email(
        OutgoingEmail(
            to=["buyer@example.com"],
            subject="Report",
            html="<p>Hi</p>",
            text="Hi",
            reply_to="lan@example.com",
            attachments=[EmailAttachment("r.pdf", b"%PDF-1.4")],
        ),
        idempotency_key="u1:k1",
    )
    assert receipt.message_id == "re_123" and receipt.sandbox is False
    assert seen["url"] == "https://api.resend.com/emails"
    assert seen["headers"]["Authorization"] == "Bearer re_key"
    assert seen["headers"]["Idempotency-key"] == "u1:k1"
    assert seen["body"]["reply_to"] == "lan@example.com"
    assert seen["body"]["attachments"] == [{"filename": "r.pdf", "content": "JVBERi0xLjQ="}]


@pytest.mark.parametrize(
    ("status", "code"), [(422, "email_rejected"), (429, "email_unavailable"), (500, "email_failed")]
)
def test_resend_errors_become_app_errors(monkeypatch, status, code):
    def failing_urlopen(request, timeout):
        body = io.BytesIO(b'{"name": "validation_error", "message": "bad"}')
        raise urllib.error.HTTPError(request.full_url, status, "error", {}, body)

    monkeypatch.setattr(email_module.urllib.request, "urlopen", failing_urlopen)
    sender = ResendEmailSender("re_key", "reports@exportmate.app")
    with pytest.raises(AppError) as raised:
        sender.send_email(OutgoingEmail(to=["a@example.com"], subject="s", html="", text=""))
    assert raised.value.code == code


@pytest.fixture
def ai_service_url(monkeypatch: pytest.MonkeyPatch):
    def use(url: str) -> None:
        monkeypatch.setenv("AI_SERVICE_URL", url)
        get_settings.cache_clear()

    yield use
    monkeypatch.delenv("AI_SERVICE_URL", raising=False)
    get_settings.cache_clear()


def test_news_alerts_forward_the_callers_token(monkeypatch, ai_service_url):
    ai_service_url("https://ai.example.run.app/")
    seen = {}

    def fake_urlopen(request, timeout):
        seen["url"] = request.full_url
        seen["auth"] = request.get_header("Authorization")
        return FakeResponse(b'{"impacts": [{"headline": "A"}, "junk"], "scan": null}')

    monkeypatch.setattr(news_alerts.urllib.request, "urlopen", fake_urlopen)
    assert news_alerts.fetch_news_alerts("Bearer t") == [{"headline": "A"}]
    assert seen == {"url": "https://ai.example.run.app/api/impacts", "auth": "Bearer t"}


def test_news_alerts_never_send_a_token_over_plain_http(monkeypatch, ai_service_url):
    ai_service_url("http://ai.example.com")
    monkeypatch.setattr(
        news_alerts.urllib.request, "urlopen", lambda *a, **k: pytest.fail("no request")
    )
    assert news_alerts.fetch_news_alerts("Bearer t") is None


def test_news_alerts_unreachable_is_none(monkeypatch, ai_service_url):
    ai_service_url("http://127.0.0.1:8080")

    def down(request, timeout):
        raise urllib.error.URLError("refused")

    monkeypatch.setattr(news_alerts.urllib.request, "urlopen", down)
    assert news_alerts.fetch_news_alerts(None) is None
