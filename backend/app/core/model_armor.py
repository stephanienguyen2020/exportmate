"""Model Armor (Google Cloud) screening for news articles, alongside core/untrusted_text.py:
a trained prompt-injection and jailbreak classifier that also catches reworded attempts, and
flags links to known-malicious sites. Off when MODEL_ARMOR_TEMPLATE is unset (local runs,
tests); the patterns still apply."""

import re
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import google.auth
import requests
from google.auth.transport.requests import AuthorizedSession

# How a withheld article names each filter, by its key in the sanitize result.
LABELS = {
    "pi_and_jailbreak": "prompt injection or jailbreak",
    "malicious_uris": "malicious link",
    "csam": "child safety",
    "rai": "harmful content",
    "sdp": "sensitive data",
}
OK_STATES = {"EXECUTION_SUCCESS", "EXECUTION_SKIPPED"}
# The prompt-injection filter reads the first 10,000 tokens; feed snippets are far shorter.
MAX_CHARS = 30_000
TIMEOUT_SECONDS = 10
RETRIES = 2
TRANSIENT = {408, 429, 500, 502, 503, 504}
TEMPLATE = re.compile(r"^projects/[^/]+/locations/([^/]+)/templates/[^/]+$")


class ArmorError(Exception):
    """The text was not screened; the caller leaves it for later rather than let it through."""


@dataclass
class Screening:
    match: str | None = None
    error: str | None = None


def verdict(response: dict) -> str | None:
    """None when nothing matched, else what matched, e.g. "model armor: malicious link"."""
    result = (response or {}).get("sanitizationResult")
    if not result or result.get("invocationResult") == "FAILURE":
        raise ArmorError("Model Armor could not screen the text")
    filters = result.get("filterResults") or {}
    injection = (filters.get("pi_and_jailbreak") or {}).get("piAndJailbreakFilterResult")
    if injection and injection.get("executionState") not in OK_STATES:
        raise ArmorError(
            f"Model Armor's prompt-injection filter did not run ({injection.get('executionState')})"
        )
    matched = []
    for key, wrapper in filters.items():
        found = next(iter((wrapper or {}).values()), None) or {}
        state = found.get("matchState") or (found.get("inspectResult") or {}).get("matchState")
        if state != "MATCH_FOUND":
            continue
        label = LABELS.get(key, key)
        level = found.get("confidenceLevel")
        matched.append(f"{label} ({level})" if level else label)
    return f"model armor: {', '.join(matched)}" if matched else None


class ModelArmor:
    def __init__(self, template: str):
        found = TEMPLATE.match(template)
        if not found:
            raise ValueError(
                "MODEL_ARMOR_TEMPLATE must look like "
                f"projects/<project>/locations/<location>/templates/<id>, not {template}"
            )
        # Sanitizing is only served from the template's regional endpoint.
        self.url = (
            f"https://modelarmor.{found.group(1)}.rep.googleapis.com/v1/"
            f"{template}:sanitizeUserPrompt"
        )
        credentials, _ = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        self.session = AuthorizedSession(credentials)

    def screen(self, text: str) -> str | None:
        """The verdict for one text; raises ArmorError if it could not be screened."""
        body = {"userPromptData": {"text": (text or "")[:MAX_CHARS]}}
        for attempt in range(RETRIES + 1):
            try:
                response = self.session.post(self.url, json=body, timeout=TIMEOUT_SECONDS)
            except requests.RequestException as error:
                if attempt == RETRIES:
                    raise ArmorError(f"Model Armor unreachable: {type(error).__name__}") from error
            else:
                if response.ok:
                    return verdict(response.json())
                if response.status_code not in TRANSIENT or attempt == RETRIES:
                    raise ArmorError(
                        f"Model Armor returned {response.status_code}: {response.text[:200]}"
                    )
            time.sleep(0.5 * 2**attempt)
        raise ArmorError("Model Armor could not screen the text")

    def screen_each(self, texts: list[str]) -> list[Screening]:
        """One Screening per text, in order, a few at a time."""

        def one(text: str) -> Screening:
            try:
                return Screening(match=self.screen(text))
            except ArmorError as error:
                return Screening(error=str(error))

        with ThreadPoolExecutor(max_workers=8) as pool:
            return list(pool.map(one, texts))
