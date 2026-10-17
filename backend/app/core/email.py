"""Outgoing email through Resend (RESEND_API_KEY), or a sandbox that delivers nothing.

The sandbox is what runs without a key (locally, in tests, and in production until a sending
domain is verified); responses say `sandbox: true` so the UI never claims a delivery.
"""

import base64
import json
import logging
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from functools import lru_cache

from app.core.config import get_settings
from app.core.errors import AppError

RESEND_URL = "https://api.resend.com/emails"
RESEND_TIMEOUT_SECONDS = 15
SANDBOX_KEEP = 50
# Resend's error messages can echo addresses; logs never carry them.
_ADDRESS = re.compile(r"[^\s<>()@,;:\"']+@[^\s<>()@,;:\"']+")

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class EmailAttachment:
    filename: str
    content: bytes


@dataclass(frozen=True)
class OutgoingEmail:
    to: list[str]
    subject: str
    html: str
    text: str
    reply_to: str | None = None
    attachments: list[EmailAttachment] = field(default_factory=list)


@dataclass(frozen=True)
class EmailReceipt:
    message_id: str
    sandbox: bool


class ResendEmailSender:
    sandbox = False

    def __init__(self, api_key: str, sender: str):
        self.api_key = api_key
        self.sender = sender

    def send_email(self, email: OutgoingEmail, idempotency_key: str | None = None) -> EmailReceipt:
        body = {
            "from": self.sender,
            "to": email.to,
            "subject": email.subject,
            "html": email.html,
            "text": email.text,
            "attachments": [
                {"filename": a.filename, "content": base64.b64encode(a.content).decode()}
                for a in email.attachments
            ],
        }
        if email.reply_to:
            body["reply_to"] = email.reply_to
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            # Resend's own default agent is blocked by some proxies; name ours.
            "User-Agent": "exportmate-backend",
        }
        if idempotency_key:
            # Resend sends once per key for 24 hours, so a double click is one email.
            headers["Idempotency-Key"] = idempotency_key
        request = urllib.request.Request(
            RESEND_URL, data=json.dumps(body).encode(), headers=headers, method="POST"
        )
        try:
            with urllib.request.urlopen(request, timeout=RESEND_TIMEOUT_SECONDS) as response:
                message_id = json.loads(response.read()).get("id", "")
        except urllib.error.HTTPError as error:
            # Resend says why ("domain is not verified", ...); its addresses are masked.
            try:
                detail = json.loads(error.read())
            except ValueError:
                detail = {}
            log.warning(
                "email.rejected",
                extra={
                    "status": error.code,
                    "provider_error": detail.get("name", ""),
                    "provider_message": _ADDRESS.sub("[address]", str(detail.get("message", "")))[
                        :300
                    ],
                },
            )
            if error.code == 429:
                raise AppError(503, "email_unavailable", "Email is busy. Try again in a minute.")
            if error.code == 422:
                raise AppError(
                    422,
                    "email_rejected",
                    "The email service refused this message. Check the addresses.",
                )
            raise AppError(502, "email_failed", "The email could not be sent.")
        except (urllib.error.URLError, TimeoutError) as error:
            log.warning("email.unreachable", extra={"error_type": type(error).__name__})
            raise AppError(503, "email_unavailable", "Email is unavailable. Try again later.")
        return EmailReceipt(message_id=message_id, sandbox=False)


class SandboxEmailSender:
    """Keeps the last messages in memory and delivers nothing."""

    sandbox = True

    def __init__(self):
        self.outbox: list[OutgoingEmail] = []
        self._sent = 0

    def send_email(self, email: OutgoingEmail, idempotency_key: str | None = None) -> EmailReceipt:
        self.outbox = [*self.outbox[-(SANDBOX_KEEP - 1) :], email]
        self._sent += 1
        return EmailReceipt(message_id=f"sandbox-{self._sent}", sandbox=True)


@lru_cache
def get_email_sender() -> ResendEmailSender | SandboxEmailSender:
    settings = get_settings()
    if settings.resend_api_key:
        return ResendEmailSender(settings.resend_api_key, settings.report_email_from)
    return SandboxEmailSender()
