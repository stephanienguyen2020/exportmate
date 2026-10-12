from contextvars import ContextVar

_request_id: ContextVar[str | None] = ContextVar("request_id", default=None)
_trace: ContextVar[str | None] = ContextVar("trace", default=None)


def current_request_id() -> str | None:
    return _request_id.get()


def set_request_id(value: str) -> None:
    _request_id.set(value)


def current_trace() -> str | None:
    """Cloud Logging trace name, e.g. "projects/<project>/traces/<id>"."""
    return _trace.get()


def set_trace(value: str | None) -> None:
    _trace.set(value)
