"""Per-user request limits, counted in memory.

Each Cloud Run instance counts on its own, so the effective limit is this times the number of
instances. That is enough to stop a runaway script or a stuck retry loop; it is not a quota.
"""

import threading
import time
from collections import deque

from app.core.errors import AppError


class RateLimiter:
    def __init__(self, name: str, window_seconds: int = 3600):
        self.name = name
        self.window_seconds = window_seconds
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def check(self, key: str, limit: int) -> None:
        """Records one hit for `key`, or raises 429 when it already used `limit` in the window."""
        now = time.monotonic()
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            while hits and now - hits[0] >= self.window_seconds:
                hits.popleft()
            if len(hits) >= limit:
                retry_minutes = max(1, round((self.window_seconds - (now - hits[0])) / 60))
                raise AppError(
                    429,
                    "rate_limited",
                    f"Too many {self.name} for now. Try again in {retry_minutes} minutes.",
                )
            hits.append(now)
            if len(self._hits) > 10_000:  # forget idle users
                self._hits = {
                    k: v for k, v in self._hits.items() if v and now - v[-1] < self.window_seconds
                }
