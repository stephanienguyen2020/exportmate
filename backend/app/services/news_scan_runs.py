"""Starting a news scan (services/news_scan.py): one at a time, and "Scan now" at most once per
SCAN_COOLDOWN after any scan.

The lock is Firestore `locks/scan` ({startedAt, running, trigger, requested, scanId, ...}),
claimed in a transaction. "Scan now" takes it with `requested`, makes the scan record (so the
page can follow it at once) and starts the Cloud Run job; the job finds the request and runs
that scan. A scheduled job finds no request, takes the lock itself, or stops if a scan is
running. Locally (no NEWS_SCAN_JOB) "Scan now" runs the scan in a thread of this process."""

import logging
import threading
from datetime import UTC, datetime, timedelta

import google.auth
from google.auth.transport.requests import AuthorizedSession
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.context import CompanyContext
from app.core.errors import AppError
from app.database.news_store import get_news_store
from app.database.queries import audit as audit_queries
from app.services import news_scan
from app.services.news_alerts import present_scan
from app.services.news_scan_rules import SCAN_POLICY_VERSION
from app.services.news_sources import news_access

SCAN_COOLDOWN = timedelta(minutes=10)

log = logging.getLogger(__name__)


def _stamp(at: datetime) -> str:
    return at.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def scan_blocked(lock: dict | None, *, scheduled: bool, now: datetime) -> tuple[int, str] | None:
    """Whether a scan may start. Scheduled scans only wait for one still running; manual ones
    also wait out the cooldown after any scan. None to go ahead, else (status, message)."""
    try:
        started = datetime.fromisoformat((lock or {}).get("startedAt") or "")
    except ValueError:
        return None
    if now - started >= SCAN_COOLDOWN:
        return None  # also frees a lock left "running" by a crashed scan
    if lock.get("running"):
        return (409 if scheduled else 429, "A scan is already running.")
    if not scheduled:
        return (429, "A scan ran in the last 10 minutes.")
    return None


def request_scan(db: Session, ctx: CompanyContext) -> dict | None:
    """ "Scan now" (owners and editors): takes the lock, makes the scan record and starts the
    job. Returns the new scan as the caller sees it."""
    store = get_news_store()
    now = datetime.now(UTC)
    refusal: list[tuple[int, str]] = []
    scan_id = store.new_scan_id()

    def claim(lock: dict | None) -> dict | None:
        blocked = scan_blocked(lock, scheduled=False, now=now)
        if blocked:
            refusal.append(blocked)
            return None
        return {
            "startedAt": _stamp(now),
            "running": True,
            "trigger": "manual",
            "requested": True,
            "scanId": scan_id,
            "userId": str(ctx.user.id),
            "companyId": str(ctx.company_id),
        }

    if store.claim_scan_lock(claim) is None:
        status, message = refusal[0]
        raise AppError(status, "scan_blocked", message)
    scan = {
        "startedAt": _stamp(now),
        "trigger": "manual",
        "status": "running",
        "model": get_settings().gemini_model,
        "policyVersion": SCAN_POLICY_VERSION,
    }
    store.start_scan(scan, scan_id)
    try:
        _start(scan_id)
    except Exception as error:
        log.exception("scan.start_failed", extra={"scan_id": scan_id})
        store.update_scan(scan_id, {"status": "failed", "finishedAt": _stamp(datetime.now(UTC))})
        store.update_scan_lock({"running": False, "requested": False})
        raise AppError(
            503, "scan_unavailable", "The scan couldn't start. Try again later."
        ) from error
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action="news_scan.started",
        object_type="news_scan",
        object_id=scan_id,
        data={},
    )
    db.commit()
    log.info("scan.requested", extra={"scan_id": scan_id})
    return present_scan({"id": scan_id, **scan}, news_access(ctx))


def _start(scan_id: str) -> None:
    job = get_settings().news_scan_job
    if not job:
        threading.Thread(target=run_claimed_scan, name=f"news-scan-{scan_id}", daemon=True).start()
        return
    credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    response = AuthorizedSession(credentials).post(
        f"https://run.googleapis.com/v2/{job}:run", json={}, timeout=30
    )
    response.raise_for_status()


def run_claimed_scan() -> dict | None:
    """What the job runs: the scan "Scan now" asked for, or a scheduled one. None when another
    scan is running."""
    store = get_news_store()
    now = datetime.now(UTC)

    def claim(lock: dict | None) -> dict | None:
        if lock and lock.get("requested") and lock.get("running"):
            return {**lock, "requested": False}
        if scan_blocked(lock, scheduled=True, now=now):
            return None
        return {"startedAt": _stamp(now), "running": True, "trigger": "schedule"}

    claimed = store.claim_scan_lock(claim)
    if claimed is None:
        log.info("scan.skipped_running")
        return None
    try:
        return news_scan.run_scan(trigger=claimed["trigger"], scan_id=claimed.get("scanId"))
    finally:
        store.update_scan_lock({"running": False})
