"""Gemini on Vertex AI, for the few steps where AI reads or writes text.

Every call asks for JSON in a fixed shape (a pydantic model), so code checks the answer before
anything is saved, and a person reviews it before it counts. Tests replace `generate_json`.
"""

import logging
import time
from functools import lru_cache
from typing import TypeVar

from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel, ValidationError

from app.core.config import get_settings
from app.core.errors import AppError

log = logging.getLogger(__name__)

AnswerT = TypeVar("AnswerT", bound=BaseModel)


@lru_cache
def _client() -> genai.Client:
    settings = get_settings()
    if not settings.google_cloud_project:
        raise AppError(503, "ai_not_configured", "AI is not set up on this server.")
    return genai.Client(
        vertexai=True,
        project=settings.google_cloud_project,
        location=settings.gemini_location,
        http_options=types.HttpOptions(timeout=settings.gemini_timeout_seconds * 1000),
    )


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
