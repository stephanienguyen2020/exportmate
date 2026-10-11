from collections.abc import Iterator
from functools import lru_cache

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session

from app.core.config import get_settings


@lru_cache
def get_engine() -> Engine:
    """Created on first use, so tests can point DATABASE_URL elsewhere before connecting."""
    return create_engine(get_settings().database_url, pool_pre_ping=True, pool_size=5)


def open_session() -> Session:
    return Session(get_engine(), autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    with open_session() as db:
        yield db
