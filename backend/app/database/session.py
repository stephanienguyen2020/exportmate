import logging
from collections.abc import Iterator
from functools import lru_cache

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session

from app.core.config import get_settings

log = logging.getLogger(__name__)
POOL_SIZE = 5


@lru_cache
def get_engine() -> Engine:
    """Created on first use, so tests can point DATABASE_URL elsewhere before connecting."""
    engine = create_engine(get_settings().database_url, pool_pre_ping=True, pool_size=POOL_SIZE)
    # Host and database name only; the URL also holds the password.
    log.info(
        "database.engine_created",
        extra={
            "database_host": engine.url.host or engine.url.query.get("host"),
            "database_name": engine.url.database,
            "pool_size": POOL_SIZE,
        },
    )
    return engine


def open_session() -> Session:
    return Session(get_engine(), autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    with open_session() as db:
        yield db
