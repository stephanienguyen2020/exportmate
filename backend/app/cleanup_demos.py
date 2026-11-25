"""Delete demo sandboxes whose time is up (services/demo.py). Opening a new sandbox already
deletes a few; run this on a schedule (e.g. a Cloud Run job once a day) for the rest.

Usage:  uv run python -m app.cleanup_demos
"""

import argparse

from app.core.config import get_settings
from app.core.logging import configure_logging
from app.database.session import open_session
from app.services.demo import delete_expired_sandboxes


def main() -> None:
    argparse.ArgumentParser(description=__doc__).parse_args()
    settings = get_settings()
    configure_logging(settings.log_level, settings.resolved_log_format)
    with open_session() as db:
        deleted = delete_expired_sandboxes(db)
    print(f"Deleted {deleted} expired demo sandboxes.")


if __name__ == "__main__":
    main()
