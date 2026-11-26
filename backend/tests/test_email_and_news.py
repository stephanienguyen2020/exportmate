"""The Resend client and the News watch client, with the network replaced."""

import io
import json
import urllib.error

import pytest

from app.core import email as email_module
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


def test_resend_refusal_is_logged_with_its_reason_but_no_address(monkeypatch, caplog):
    def failing_urlopen(request, timeout):
        body = io.BytesIO(
            b'{"name": "validation_error", "message": "The exportmate.app domain is not verified.'
            b' You can only send testing emails to your own email address (owner@example.com)."}'
        )
        raise urllib.error.HTTPError(request.full_url, 403, "error", {}, body)

    monkeypatch.setattr(email_module.urllib.request, "urlopen", failing_urlopen)
    sender = ResendEmailSender("re_key", "reports@exportmate.app")
    with pytest.raises(AppError) as raised, caplog.at_level("WARNING"):
        sender.send_email(OutgoingEmail(to=["a@example.com"], subject="s", html="", text=""))
    assert raised.value.code == "email_failed"
    rejected = next(r for r in caplog.records if r.getMessage() == "email.rejected")
    assert rejected.provider_error == "validation_error"
    assert "domain is not verified" in rejected.provider_message
    assert "@" not in rejected.provider_message and "[address]" in rejected.provider_message
