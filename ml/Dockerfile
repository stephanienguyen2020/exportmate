# The Order features job's image (Cloud Run job exportmate-order-features, infra/terraform/trade_risk.tf).
# Code only: the prepared data and the trained model are read from the ML bucket, mounted at
# /mnt/ml (ML_DATA_DIR, ML_MODELS_DIR). Settings come from the environment (no .env in the image).
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.8.23 /uv /bin/uv

# LightGBM needs OpenMP.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

# Dependencies first, so code changes don't reinstall them.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY trade_risk ./trade_risk

RUN useradd --create-home appuser
USER appuser

# The backend and the monthly schedule only pass arguments (--new, --pair US:VN:441231, none).
ENTRYPOINT ["python", "-m", "trade_risk.job"]
