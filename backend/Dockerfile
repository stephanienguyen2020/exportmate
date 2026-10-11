# Cloud Run image. Settings come from environment variables (no .env in the image).
# Same image runs migrations: override the command with `alembic upgrade head`.
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.8.23 /uv /bin/uv

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

# Dependencies first, so code changes don't reinstall them.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY alembic.ini ./
COPY migrations ./migrations
COPY app ./app

RUN useradd --create-home appuser
USER appuser

# Cloud Run sets PORT (8080 by default).
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]
