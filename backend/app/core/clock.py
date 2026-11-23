"""Today's date. The app reads it only from here, so the tests can fix it (tests/conftest.py)."""

from datetime import UTC, date, datetime


def today() -> date:
    return datetime.now(UTC).date()
