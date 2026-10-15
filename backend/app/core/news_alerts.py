"""News alerts from the AI service (ai/server, GET /api/impacts), read with the caller's token
so the company's own sources and switched-off ones apply, and the sample stock they name
(GET /api/inventory). The backend stores none of it."""

import json
import logging
import re
import urllib.error
import urllib.request

from app.core.config import get_settings

TIMEOUT_SECONDS = 8
_LOCAL = re.compile(r"^http://(127\.0\.0\.1|localhost)(:\d+)?$")

log = logging.getLogger(__name__)


def _fetch_list(path: str, key: str, authorization: str | None) -> list[dict] | None:
    base = get_settings().ai_service_url.rstrip("/")
    # The caller's token only ever goes to HTTPS, or to this machine in development.
    if not (base.startswith("https://") or _LOCAL.match(base)):
        log.warning("news_alerts.bad_url")
        return None
    headers = {"Accept": "application/json"}
    if authorization:
        headers["Authorization"] = authorization
    request = urllib.request.Request(f"{base}{path}", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            items = json.loads(response.read()).get(key)
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        log.warning("news_alerts.unavailable", extra={"error_type": type(error).__name__})
        return None
    if not isinstance(items, list):
        log.warning("news_alerts.unexpected_response")
        return None
    return [i for i in items if isinstance(i, dict)]


def fetch_news_alerts(authorization: str | None) -> list[dict] | None:
    """The company's recent alerts, or None when the AI service can't be reached."""
    return _fetch_list("/api/impacts", "impacts", authorization)


def fetch_news_stock(authorization: str | None) -> list[dict] | None:
    """The sample stock items alerts name (SKU, HS code, markets), or None when unreachable."""
    return _fetch_list("/api/inventory", "items", authorization)
