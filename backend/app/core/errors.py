"""One error shape for every failure: {"error": {code, message, fieldErrors, requestId}}."""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.request_context import current_request_id

log = logging.getLogger(__name__)


class AppError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        field_errors: dict[str, str] | None = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.field_errors = field_errors or {}


def not_found_error(what: str = "Resource") -> AppError:
    return AppError(404, "not_found", f"{what} not found.")


def _error_body(code: str, message: str, field_errors: dict | None = None) -> dict:
    return {
        "error": {
            "code": code,
            "message": message,
            "fieldErrors": field_errors or {},
            "requestId": current_request_id(),
        }
    }


_HTTP_CODES = {
    401: "unauthenticated",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
}


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def app_error(request: Request, exc: AppError):
        log.log(
            logging.ERROR if exc.status >= 500 else logging.INFO,
            "request.rejected",
            extra={"code": exc.code, "status": exc.status, "path": request.url.path},
        )
        return JSONResponse(
            _error_body(exc.code, exc.message, exc.field_errors), status_code=exc.status
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        fields = {}
        for err in exc.errors():
            loc = [str(p) for p in err["loc"] if p not in ("body", "query", "path")]
            # Our validators raise ValueError; Pydantic prefixes those with "Value error, ".
            fields[".".join(loc) or "request"] = err["msg"].removeprefix("Value error, ")
        # Field names only; values could be personal data.
        log.info("request.invalid", extra={"path": request.url.path, "fields": sorted(fields)})
        return JSONResponse(
            _error_body("invalid_input", "Some fields are invalid.", fields), status_code=422
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, exc: StarletteHTTPException):
        code = _HTTP_CODES.get(exc.status_code, "http_error")
        return JSONResponse(_error_body(code, str(exc.detail)), status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def unexpected(request: Request, exc: Exception):
        log.exception(
            "request.unhandled_error",
            extra={"path": request.url.path, "error_type": type(exc).__name__},
        )
        return JSONResponse(_error_body("internal", "Something went wrong."), status_code=500)
