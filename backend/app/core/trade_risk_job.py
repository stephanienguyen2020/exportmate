"""Start the Order features job (ml/trade_risk/order_features.py) for pairs that have no score yet.

Orders' pairs are in `order_trade_pairs`, so for them the job runs with `--new` and finds the
unscored pairs itself; a pair no order has (a what-if) is passed with `--pair`. Production runs
the Cloud Run job `TRADE_RISK_JOB`; locally `TRADE_RISK_JOB_COMMAND` runs in `TRADE_RISK_JOB_DIR`.
Each start runs in the background, so the request that asked never waits for it. A pair asked for
again within `REPEAT_AFTER_SECONDS` doesn't start the job again (per instance).
"""

import logging
import shlex
import subprocess
import threading
import time

import google.auth
from google.auth.exceptions import GoogleAuthError
from google.auth.transport.requests import AuthorizedSession

from app.core.config import get_settings

CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
REPEAT_AFTER_SECONDS = 600
TIMEOUT_SECONDS = 20

log = logging.getLogger(__name__)
_started: dict[str, float] = {}
_lock = threading.Lock()


def pair_argument(destination: str, exporter: str, hs6: str) -> str:
    """What the job's --pair takes: destination country, exporting country, HS code."""
    return f"{destination}:{exporter}:{hs6}"


def _run_cloud_job(job: str, args: list[str]) -> None:
    credentials, _ = google.auth.default(scopes=[CLOUD_PLATFORM_SCOPE])
    # The job's image runs `python -m trade_risk.order_features`; only the arguments change.
    body = {"overrides": {"containerOverrides": [{"args": args}]}}
    response = AuthorizedSession(credentials).post(
        f"https://run.googleapis.com/v2/{job}:run", json=body, timeout=TIMEOUT_SECONDS
    )
    response.raise_for_status()


def _run_local_command(command: str, directory: str, args: list[str]) -> None:
    subprocess.Popen(
        [*shlex.split(command), *args],
        cwd=directory,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _start(args: list[str]) -> None:
    settings = get_settings()
    try:
        if settings.trade_risk_job:
            _run_cloud_job(settings.trade_risk_job, args)
        else:
            _run_local_command(settings.trade_risk_job_command, settings.trade_risk_job_dir, args)
        log.info("trade_risk.backfill_started", extra={"arguments": len(args)})
    # requests' errors are OSErrors. The monthly run scores the pair anyway.
    except (GoogleAuthError, OSError, ValueError) as error:
        log.warning("trade_risk.backfill_failed", extra={"error_type": type(error).__name__})


def _request(pairs: list[str], args_for) -> bool:
    """Start the job for the pairs not started recently. False when no job is configured."""
    settings = get_settings()
    if not (settings.trade_risk_job or settings.trade_risk_job_command):
        return False
    now = time.monotonic()
    with _lock:
        new = [
            p for p in pairs if now - _started.get(p, -REPEAT_AFTER_SECONDS) >= REPEAT_AFTER_SECONDS
        ]
        for pair in new:
            _started[pair] = now
    if new:
        threading.Thread(target=_start, args=(args_for(new),), daemon=True).start()
    return True


def start_new_order_pairs(pairs: list[str]) -> bool:
    """Orders' pairs just saved in order_trade_pairs without a score: the job finds them itself."""
    return _request(pairs, lambda _: ["--new"])


def start_pairs(pairs: list[str]) -> bool:
    """Pairs no order has (a what-if, the assistant): named to the job."""
    return _request(pairs, lambda new: [arg for pair in new for arg in ("--pair", pair)])
