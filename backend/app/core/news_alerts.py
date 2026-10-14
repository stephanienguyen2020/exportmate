"""News alerts from the AI service (ai/server, GET /api/impacts), read with the caller's token
so the company's own sources and switched-off ones apply. The backend stores none of it."""

import json
import logging
import re
import urllib.error
import urllib.request

from app.core.config import get_settings

TIMEOUT_SECONDS = 8
_LOCAL = re.compile(r"^http://(127\.0\.0\.1|localhost)(:\d+)?$")

log = logging.getLogger(__name__)


def fetch_news_alerts(authorization: str | None) -> list[dict] | None:
    """The company's recent alerts, or None when the AI service can't be reached."""
    base = get_settings().ai_service_url.rstrip("/")
    # The caller's token only ever goes to HTTPS, or to this machine in development.
    if not (base.startswith("https://") or _LOCAL.match(base)):
        log.warning("news_alerts.bad_url")
        return None
    headers = {"Accept": "application/json"}
    if authorization:
        headers["Authorization"] = authorization
    request = urllib.request.Request(f"{base}/api/impacts", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            impacts = json.loads(response.read()).get("impacts")
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        log.warning("news_alerts.unavailable", extra={"error_type": type(error).__name__})
        return None
    if not isinstance(impacts, list):
        log.warning("news_alerts.unexpected_response")
        return None
    return [i for i in impacts if isinstance(i, dict)]
