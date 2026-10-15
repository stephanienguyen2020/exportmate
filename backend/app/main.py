import logging
import time
import uuid

from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.engine import make_url

from app.api import (
    account,
    analysis,
    audit_log,
    company_sites,
    cost_settings,
    health,
    hs_suggestions,
    imports,
    market_requirements,
    orders,
    playbook,
    regulations,
    reports,
    supplier_documents,
    supplier_messages,
    suppliers,
    trade_map,
)
from app.core.config import get_settings
from app.core.errors import register_error_handlers
from app.core.logging import configure_logging
from app.core.request_context import set_request_id, set_trace

API_PREFIX = "/api/v1"
QUIET_PATHS = {f"{API_PREFIX}/health"}

log = logging.getLogger("app.request")


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level, settings.resolved_log_format)
    database = make_url(settings.database_url)
    logging.getLogger(__name__).info(
        "app.starting",
        extra={
            "env": settings.env,
            "auth_mode": settings.auth_mode,
            "firebase_project": settings.firebase_project_id,
            "database_host": database.host or database.query.get("host"),
            "database_name": database.database,
            "allowed_origins": len(settings.origins),
        },
    )

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
        allow_headers=["Authorization", "Content-Type", "X-Request-ID", "Idempotency-Key"],
        expose_headers=["X-Request-ID"],
    )

    @app.middleware("http")
    async def attach_request_id(request: Request, call_next):
        request_id = (request.headers.get("X-Request-ID") or uuid.uuid4().hex)[:64]
        set_request_id(request_id)
        # "TRACE_ID/SPAN_ID;o=1" from Cloud Run's load balancer.
        trace_header = request.headers.get("X-Cloud-Trace-Context", "")
        trace_id = trace_header.split("/")[0]
        project = settings.google_cloud_project or settings.firebase_project_id
        set_trace(f"projects/{project}/traces/{trace_id}" if trace_id else None)

        started = time.perf_counter()
        # Unhandled exceptions are logged with their traceback by the 500 handler in errors.py.
        response = await call_next(request)
        duration_ms = round((time.perf_counter() - started) * 1000, 1)
        response.headers["X-Request-ID"] = request_id
        level = (
            logging.ERROR
            if response.status_code >= 500
            else logging.WARNING
            if response.status_code >= 400
            else logging.DEBUG
            if request.url.path in QUIET_PATHS
            else logging.INFO
        )
        # Path only: query strings can hold search text we don't need in logs.
        log.log(
            level,
            "request.completed",
            extra={
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "duration_ms": duration_ms,
                "user_id": getattr(request.state, "user_id", None),
                "company_id": getattr(request.state, "company_id", None),
            },
        )
        return response

    register_error_handlers(app)

    api = APIRouter(prefix=API_PREFIX)
    for module in (
        health,
        account,
        orders,
        imports,
        playbook,
        trade_map,
        suppliers,
        company_sites,
        regulations,
        reports,
        regulations,
        cost_settings,
        analysis,
        supplier_documents,
        market_requirements,
        hs_suggestions,
        supplier_messages,
        audit_log,
    ):
        api.include_router(module.router)
    app.include_router(api)
    return app


app = create_app()
