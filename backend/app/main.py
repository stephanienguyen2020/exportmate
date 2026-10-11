import logging
import uuid

from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.api import account, health, imports, orders, playbook
from app.core.config import get_settings
from app.core.errors import register_error_handlers
from app.core.request_context import set_request_id

API_PREFIX = "/api/v1"


def create_app() -> FastAPI:
    settings = get_settings()
    logging.basicConfig(level=logging.INFO)

    app = FastAPI(
        title="ExportMate API",
        version="0.1.0",
        docs_url=f"{API_PREFIX}/docs",
        openapi_url=f"{API_PREFIX}/openapi.json",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.origins,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
        expose_headers=["X-Request-ID"],
    )

    @app.middleware("http")
    async def attach_request_id(request: Request, call_next):
        request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex
        set_request_id(request_id[:64])
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id[:64]
        return response

    register_error_handlers(app)

    api = APIRouter(prefix=API_PREFIX)
    for module in (health, account, orders, imports, playbook):
        api.include_router(module.router)
    app.include_router(api)
    return app


app = create_app()
