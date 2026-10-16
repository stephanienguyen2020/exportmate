"""Gemini on Vertex AI, for the few steps where AI reads or writes text, and embeddings for
search (HS headings, sections of a long document).

Every call asks for JSON in a fixed shape (a pydantic model), so code checks the answer before
anything is saved, and a person reviews it before it counts. Tests replace `generate_json` and
`embed_texts`.
"""

import logging
import time
from functools import lru_cache
from typing import TypeVar

from google import genai
from google.auth import exceptions as google_auth_errors
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel, ValidationError

from app.core.config import get_settings
from app.core.errors import AppError

log = logging.getLogger(__name__)

AnswerT = TypeVar("AnswerT", bound=BaseModel)
EMBEDDING_DIMENSIONS = 768  # hs_headings.embedding
EMBED_BATCH = 50
# Transient answers worth another attempt: timeouts, rate limits, cancelled (499) and server
# errors. Timeouts on our side are retried too.
RETRY_STATUS_CODES = [408, 429, 499, 500, 502, 503, 504]


@lru_cache
def _client() -> genai.Client:
    settings = get_settings()
    if not settings.google_cloud_project:
        raise AppError(503, "ai_not_configured", "AI is not set up on this server.")
    return genai.Client(
        vertexai=True,
        project=settings.google_cloud_project,
        location=settings.gemini_location,
        http_options=types.HttpOptions(
            timeout=settings.gemini_timeout_seconds * 1000,
            retry_options=types.HttpRetryOptions(
                attempts=settings.gemini_attempts, http_status_codes=RETRY_STATUS_CODES
            ),
        ),
    )


def _no_credentials(error: google_auth_errors.GoogleAuthError, task: str) -> AppError:
    """No usable Google credentials (locally: `gcloud auth application-default login`)."""
    log.warning("gemini.no_credentials", extra={"task": task, "error": type(error).__name__})
    return AppError(503, "ai_not_configured", "AI is not set up on this server.")


def generate_json(
    task: str,
    prompt: str,
    schema: type[AnswerT],
    file: tuple[bytes, str] | None = None,
) -> AnswerT:
    """Ask Gemini for one `schema` object. `file` is (bytes, MIME type), sent before the prompt.

    `task` names the job in logs (e.g. "supplier_document_reading"); prompts and answers are not
    logged, since they hold company documents."""
    settings = get_settings()
    contents: list = [prompt]
    if file:
        contents.insert(0, types.Part.from_bytes(data=file[0], mime_type=file[1]))
    started = time.perf_counter()
    try:
        response = _client().models.generate_content(
            model=settings.gemini_model,
            contents=contents,
            config=types.GenerateContentConfig(
                temperature=0,
                response_mime_type="application/json",
                response_schema=schema,
            ),
        )
        result = schema.model_validate_json(response.text or "")
    except google_auth_errors.GoogleAuthError as error:
        raise _no_credentials(error, task)
    except (genai_errors.APIError, ValidationError, ValueError) as error:
        log.warning(
            "gemini.failed",
            extra={"task": task, "model": settings.gemini_model, "error": type(error).__name__},
        )
        raise AppError(503, "ai_unavailable", "The AI step failed. Try again in a minute.")
    log.info(
        "gemini.completed",
        extra={
            "task": task,
            "model": settings.gemini_model,
            "duration_ms": round((time.perf_counter() - started) * 1000, 1),
        },
    )
    return result


def embed_texts(texts: list[str], task_type: str) -> list[list[float]]:
    """One vector per text. `task_type` is "RETRIEVAL_DOCUMENT" for what is searched and
    "RETRIEVAL_QUERY" for what is searched with. Raises AppError 503 when it fails."""
    settings = get_settings()
    vectors: list[list[float]] = []
    started = time.perf_counter()
    try:
        for i in range(0, len(texts), EMBED_BATCH):
            response = _client().models.embed_content(
                model=settings.embedding_model,
                contents=texts[i : i + EMBED_BATCH],
                config=types.EmbedContentConfig(
                    task_type=task_type, output_dimensionality=EMBEDDING_DIMENSIONS
                ),
            )
            vectors += [e.values for e in response.embeddings]
    except google_auth_errors.GoogleAuthError as error:
        raise _no_credentials(error, "embedding")
    except genai_errors.APIError as error:
        log.warning(
            "gemini.embedding_failed",
            extra={"model": settings.embedding_model, "error": type(error).__name__},
        )
        raise AppError(503, "ai_unavailable", "The AI step failed. Try again in a minute.")
    log.info(
        "gemini.embedded",
        extra={
            "model": settings.embedding_model,
            "texts": len(texts),
            "duration_ms": round((time.perf_counter() - started) * 1000, 1),
        },
    )
    return vectors
