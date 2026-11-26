"""How the backend reaches the assistant's agents (ai/server/runtime.js), set by AGENTS_AT:

  "runtime"    the Agent Runtime instance AGENT_RUNTIME, through Agent Platform's
               reasoningEngines streamQuery / query APIs with this service's identity
  http(s) URL  a runtime.js running elsewhere (locally: `npm run runtime` in ai/server)
  empty        not set up: the assistant's routes answer 503

The agents answer a chat turn as NDJSON events ({type: "step" | "done" | "error", ...}) and the
class methods query, list_memories and delete_memory as {output}. The same contract as the AI
service's agents/remote.js."""

import json
import re
import threading
from collections.abc import Iterator
from functools import lru_cache

import google.auth
import requests
from google.auth.transport.requests import AuthorizedSession

from app.core.config import get_settings
from app.core.errors import AppError

RUNTIME_NAME = re.compile(r"^projects/[^/]+/locations/([^/]+)/reasoningEngines/\d+$")
# A chat turn streams for up to a few minutes; a class method answers within a minute.
CONNECT_SECONDS = 10
STREAM_SECONDS = 300
CALL_SECONDS = 60


class AgentsError(Exception):
    """The agents couldn't be reached or answered with an error."""


class Agents:
    def __init__(self, agents_at: str, runtime: str):
        self.agents_at = agents_at
        self.runtime = runtime
        self._keep_days: int | None = None
        self._keep_days_read = False
        self._lock = threading.Lock()
        if agents_at == "runtime":
            found = RUNTIME_NAME.match(runtime)
            if not found:
                raise AppError(
                    503, "assistant_not_configured", "AGENTS_AT=runtime needs AGENT_RUNTIME."
                )
            self.base = f"https://{found.group(1)}-aiplatform.googleapis.com"
            credentials, _ = google.auth.default(
                scopes=["https://www.googleapis.com/auth/cloud-platform"]
            )
            self.http = AuthorizedSession(credentials)
        else:
            self.base = agents_at.rstrip("/")
            self.http = requests.Session()

    def _url(self, stream: bool) -> str:
        if self.agents_at == "runtime":
            return f"{self.base}/v1/{self.runtime}:{'streamQuery' if stream else 'query'}"
        return f"{self.base}/api/{'stream_reasoning_engine' if stream else 'reasoning_engine'}"

    def _post(self, stream: bool, body: dict, timeout: int) -> requests.Response:
        try:
            response = self.http.post(
                self._url(stream), json=body, stream=stream, timeout=(CONNECT_SECONDS, timeout)
            )
        except requests.RequestException as error:
            raise AgentsError(f"Agents unreachable: {type(error).__name__}") from error
        if response.status_code != 200:
            raise AgentsError(f"Agents answered {response.status_code}: {response.text[:300]}")
        return response

    def stream_turn(self, turn: dict) -> Iterator[dict]:
        """A chat turn's events as they arrive."""
        response = self._post(True, {"class_method": "stream_query", "input": turn}, STREAM_SECONDS)
        with response:
            for line in response.iter_lines(decode_unicode=True):
                if line and line.strip():
                    yield json.loads(line)

    def call(self, method: str, payload: dict) -> dict:
        """One class method (list_memories, delete_memory); returns its output."""
        response = self._post(False, {"class_method": method, "input": payload}, CALL_SECONDS)
        return response.json().get("output") or {}

    def memory_keep_days(self) -> int | None:
        """How many days Memory Bank keeps a memory (the instance's default TTL, set by
        ai/server/platform/runtime.py); read once, None when unknown."""
        if self.agents_at != "runtime":
            return None
        with self._lock:
            if not self._keep_days_read:
                try:
                    engine = self.http.get(
                        f"{self.base}/v1beta1/{self.runtime}", timeout=CALL_SECONDS
                    ).json()
                    self._keep_days = keep_days_of(engine)
                    self._keep_days_read = True
                except (requests.RequestException, ValueError):
                    return None
            return self._keep_days


def keep_days_of(engine: dict) -> int | None:
    """Days from a reasoning engine's contextSpec.memoryBankConfig.ttlConfig.defaultTtl."""
    ttl = (
        (((engine.get("contextSpec") or {}).get("memoryBankConfig") or {}).get("ttlConfig") or {})
        .get("defaultTtl", "")
        .rstrip("s")
    )
    return round(int(ttl) / 86400) if ttl.isdigit() and int(ttl) > 0 else None


@lru_cache
def get_agents() -> Agents:
    settings = get_settings()
    if not settings.agents_at:
        raise AppError(
            503, "assistant_not_configured", "The assistant is not set up here (AGENTS_AT)."
        )
    return Agents(settings.agents_at, settings.agent_runtime)
