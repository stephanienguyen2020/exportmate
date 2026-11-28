import threading
import time
from concurrent.futures import ThreadPoolExecutor

from app.core import gemini
from app.core.config import get_settings


def test_threads_share_one_client(monkeypatch):
    """Threads asking at once get one client: a second one would be garbage-collected and close
    the connection under a request in flight (the HS benchmark's 8 workers hit this)."""
    made = []

    def slow_client(location):
        time.sleep(0.05)  # wide enough for every thread to arrive before the first is made
        made.append(object())
        return made[-1]

    monkeypatch.setattr(gemini, "_cached_clients", {})
    monkeypatch.setattr(gemini, "_new_client", slow_client)
    start = threading.Barrier(8)

    def ask(_):
        start.wait()
        return gemini._client()

    with ThreadPoolExecutor(max_workers=8) as pool:
        clients = list(pool.map(ask, range(8)))
    assert len(made) == 1
    assert all(c is made[0] for c in clients)


def test_gemini_project_overrides_the_cloud_project(monkeypatch):
    """GEMINI_PROJECT sends Gemini calls to another project's quota; unset, the backend's own."""
    made = []
    monkeypatch.setattr(gemini.genai, "Client", lambda **kwargs: made.append(kwargs))
    settings = get_settings().model_copy(
        update={"google_cloud_project": "home", "gemini_project": ""}
    )
    monkeypatch.setattr(gemini, "get_settings", lambda: settings)
    gemini._new_client("global")
    settings.gemini_project = "other"
    gemini._new_client("global")
    assert [m["project"] for m in made] == ["home", "other"]
