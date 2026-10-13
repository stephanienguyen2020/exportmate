"""Delete uploaded order files that were never committed (invalid, or validated and left).

Committed imports are kept: their file and rows are the evidence orders and reports cite.
Run it on a schedule (e.g. a Cloud Run job once a day).

Usage:  uv run python -m app.cleanup_imports --older-than-days 30
"""

import argparse
from datetime import timedelta

from app.core.config import get_settings
from app.core.logging import configure_logging
from app.database.session import open_session
from app.services.order_imports import delete_stale_imports


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--older-than-days", type=int, default=30)
    args = parser.parse_args()
    settings = get_settings()
    configure_logging(settings.log_level, settings.resolved_log_format)
    with open_session() as db:
        deleted = delete_stale_imports(db, timedelta(days=args.older_than_days))
    print(f"Deleted {deleted} uncommitted imports older than {args.older_than_days} days.")


if __name__ == "__main__":
    main()
