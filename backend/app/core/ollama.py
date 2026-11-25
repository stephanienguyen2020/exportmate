"""A local model server (Ollama) behind the same two calls as core/gemini.py, for testing when
Vertex AI isn't available: set AI_PROVIDER=ollama, GEMINI_MODEL to a chat model and
EMBEDDING_MODEL to an embedding model with 768 dimensions (hs_headings.embedding).

Vectors from different models don't compare: embed the tariff lines with the same model you
search with (a separate database is simplest).
"""

import logging
import time
from typing import TypeVar

import httpx
from pydantic import BaseModel, ValidationError

from app.core.config import get_settings
from app.core.errors import AppError

log = logging.getLogger(__name__)
AnswerT = TypeVar("AnswerT", bound=BaseModel)


def _post(path: str, body: dict) -> dict:
    settings = get_settings()
    response = httpx.post(
        settings.ollama_url.rstrip("/") + path,
        json=body,
        timeout=settings.gemini_timeout_seconds,
    )
    response.raise_for_status()
    return response.json()


def generate_json(task: str, prompt: str, schema: type[AnswerT]) -> AnswerT:
    settings = get_settings()
    started = time.perf_counter()
    try:
        answer = _post(
            "/api/chat",
            {
                "model": settings.gemini_model,
                "messages": [{"role": "user", "content": prompt}],
                "format": schema.model_json_schema(),  # Ollama's structured output
                "think": False,
                "stream": False,
                "options": {"temperature": 0},
            },
        )
        result = schema.model_validate_json(answer["message"]["content"])
    except (httpx.HTTPError, KeyError, ValidationError, ValueError) as error:
        log.warning(
            "ollama.failed",
            extra={"task": task, "model": settings.gemini_model, "error": type(error).__name__},
        )
        raise AppError(503, "ai_unavailable", "The AI step failed. Try again in a minute.")
    log.info(
        "ollama.completed",
        extra={
            "task": task,
            "model": settings.gemini_model,
            "duration_ms": round((time.perf_counter() - started) * 1000, 1),
        },
    )
    return result


def embed_texts(texts: list[str], dimensions: int, batch: int) -> list[list[float]]:
    settings = get_settings()
    vectors: list[list[float]] = []
    try:
        for i in range(0, len(texts), batch):
            answer = _post(
                "/api/embed", {"model": settings.embedding_model, "input": texts[i : i + batch]}
            )
            vectors += answer["embeddings"]
    except (httpx.HTTPError, KeyError) as error:
        log.warning(
            "ollama.embedding_failed",
            extra={"model": settings.embedding_model, "error": type(error).__name__},
        )
        raise AppError(503, "ai_unavailable", "The AI step failed. Try again in a minute.")
    if any(len(v) != dimensions for v in vectors):
        raise AppError(
            503,
            "ai_not_configured",
            f"{settings.embedding_model} doesn't give {dimensions}-dimension vectors.",
        )
    return vectors
