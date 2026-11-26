"""The news scan job (services/news_scan.py): runs the scan "Scan now" asked for, or a scheduled
one, unless a scan is already running.

Run by Cloud Scheduler (daily) and POST /news-scans through the Cloud Run job
exportmate-backend-news-scan (infra/terraform/backend_service.tf); locally:
uv run python -m app.run_news_scan   (needs GOOGLE_CLOUD_PROJECT and Google credentials)
"""

import json
import sys

from app.core.config import get_settings
from app.core.logging import configure_logging
from app.services.news_scan_runs import run_claimed_scan


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, settings.resolved_log_format)
    scan = run_claimed_scan()
    if scan is None:
        print("A scan is already running; nothing to do.")
        return
    print(json.dumps({k: v for k, v in scan.items() if k != "sources"}, indent=2))
    if scan.get("status") == "failed":
        sys.exit(1)


if __name__ == "__main__":
    main()
