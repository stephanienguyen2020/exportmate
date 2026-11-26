"""News watch's alerts as the caller may see them (moved from the AI service's GET /api/impacts
and access.js). The news scan (services/news_scan.py) writes them to Firestore `impacts` and
`scans`.

An alert is about one company's goods and carries its id: only that company sees it (signed
out, the demo company, services/news_sources.py news_access). It must also pass the caller's
age rule, and come from a source the caller sees and has switched on. An alert whose sources
were deleted falls back to the owners stored with it (`sourceCompanyIds`); one from before
sources had owners is shared."""

import logging

from google.api_core.exceptions import GoogleAPIError
from google.auth.exceptions import GoogleAuthError

from app.core.config import get_settings
from app.core.context import CompanyContext
from app.core.errors import AppError
from app.database.news_store import get_news_store
from app.schemas.news_alerts import NewsAlertsOut
from app.services.news_sources import NewsAccess, news_access, source_enabled, source_visible

# Alerts read per request, and shown.
RECENT_ALERTS = 120
SHOWN_ALERTS = 60

log = logging.getLogger(__name__)


def skips_old(access: NewsAccess, max_age_days: int) -> bool:
    return max_age_days > 0 and not access.skip_old_off


def _source_ids(item: dict) -> list[str]:
    """The sources an alert came from; older ones carry one `sourceId`."""
    ids = item.get("sourceIds")
    if isinstance(ids, list) and ids:
        return ids
    return [item["sourceId"]] if item.get("sourceId") else []


def goods_visible(item: dict, access: NewsAccess) -> bool:
    """An alert only to the company whose goods it is about; other records pass."""
    if not isinstance(item.get("affected"), list):
        return True
    return item.get("companyId") == access.company_id


def alert_visible(
    item: dict, sources_by_id: dict[str, dict], access: NewsAccess, max_age_days: int
) -> bool:
    if not goods_visible(item, access):
        return False
    # Older than the age rule when scanned; alerts scanned before the rule have no ageDays.
    age = item.get("ageDays")
    if skips_old(access, max_age_days) and isinstance(age, int | float) and age > max_age_days:
        return False
    ids = _source_ids(item)
    if not ids:
        return True
    known = [sources_by_id[i] for i in ids if i in sources_by_id]
    if known:
        return any(source_visible(s, access) and source_enabled(s, access) for s in known)
    # A null owner is a shared source.
    owners = item.get("sourceCompanyIds") or []
    return not owners or any(not o or o == access.company_id for o in owners)


def present_scan(scan: dict | None, access: NewsAccess) -> dict | None:
    """A scan as the caller sees it: `impactsFound` counts the alerts raised for the caller's
    goods, and other companies' counts and own sources are neither named nor counted."""
    if not scan:
        return scan
    shown = {k: v for k, v in scan.items() if k != "companyImpacts"}
    if isinstance(shown.get("sources"), list):
        shown["sources"] = [
            {k: v for k, v in s.items() if k != "companyId"}
            for s in shown["sources"]
            if source_visible(s, access)
        ]
    shown["impactsFound"] = (scan.get("companyImpacts") or {}).get(access.company_id, 0)
    return shown


def _recent_alerts(access: NewsAccess) -> list[dict]:
    own = get_news_store().list_company_alerts(access.company_id)
    return sorted(own, key=lambda a: str(a.get("createdAt", "")), reverse=True)[:RECENT_ALERTS]


def _visible_alerts(access: NewsAccess) -> list[dict]:
    max_age_days = get_settings().scan_max_age_days
    sources_by_id = {s["id"]: s for s in get_news_store().list_sources()}
    return [
        a for a in _recent_alerts(access) if alert_visible(a, sources_by_id, access, max_age_days)
    ][:SHOWN_ALERTS]


def list_news_alerts(ctx: CompanyContext | None) -> NewsAlertsOut:
    access = news_access(ctx)
    scan = get_news_store().get_latest_scan()
    return NewsAlertsOut(impacts=_visible_alerts(access), scan=present_scan(scan, access))


def fetch_news_alerts(ctx: CompanyContext | None) -> list[dict] | None:
    """The caller's recent alerts, or None when News watch can't be read (reports and order
    suggestions then say so)."""
    try:
        return _visible_alerts(news_access(ctx))
    except (AppError, GoogleAPIError, GoogleAuthError) as error:  # unreachable or not set up
        log.warning("news_alerts.unavailable", extra={"error_type": type(error).__name__})
        return None
