import threading
import time
from concurrent.futures import ThreadPoolExecutor

from app.core import gemini


def test_threads_share_one_client(monkeypatch):
    """Threads asking at once get one client: a second one would be garbage-collected and close
    the connection under a request in flight (the HS benchmark's 8 workers hit this)."""
    made = []

    def slow_client():
        time.sleep(0.05)  # wide enough for every thread to arrive before the first is made
        made.append(object())
        return made[-1]

    monkeypatch.setattr(gemini, "_cached_client", None)
    monkeypatch.setattr(gemini, "_new_client", slow_client)
    start = threading.Barrier(8)

    def ask(_):
        start.wait()
        return gemini._client()

    with ThreadPoolExecutor(max_workers=8) as pool:
        clients = list(pool.map(ask, range(8)))
    assert len(made) == 1
    assert all(c is made[0] for c in clients)
