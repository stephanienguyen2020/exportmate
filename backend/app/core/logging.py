"""Log setup: every line carries the request ID; production writes JSON for Cloud Logging.

Pass structured fields with `extra`, e.g. `log.info("import.committed", extra={"orders": 12})`.
Never log tokens, passwords, file contents or email addresses; log user and company IDs.
"""

import json
import logging
import sys
from datetime import UTC, datetime

from app.core.request_context import current_request_id, current_trace

# Attributes every LogRecord has; anything else came in through `extra`. Uvicorn also
# passes `color_message`, a copy of the message with terminal colour codes.
_STANDARD_ATTRS = set(vars(logging.makeLogRecord({}))) | {
    "message",
    "asctime",
    "request_id",
    "color_message",
}


def _extra_fields(record: logging.LogRecord) -> dict:
    return {k: v for k, v in vars(record).items() if k not in _STANDARD_ATTRS}


_base_record_factory = logging.getLogRecordFactory()


def _record_with_request_id(*args, **kwargs) -> logging.LogRecord:
    # Set when the record is created, so every handler (including pytest's) sees it.
    record = _base_record_factory(*args, **kwargs)
    record.request_id = current_request_id() or "-"
    return record


class JsonFormatter(logging.Formatter):
    """One JSON object per line. Cloud Logging reads `severity`, `message` and the trace."""

    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "severity": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "requestId": record.request_id,
            **_extra_fields(record),
        }
        trace = current_trace()
        if trace:
            entry["logging.googleapis.com/trace"] = trace
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


class TextFormatter(logging.Formatter):
    """Readable lines for local development, with extra fields as key=value."""

    def __init__(self) -> None:
        super().__init__("%(asctime)s %(levelname)-7s %(name)s [%(request_id)s] %(message)s")

    def format(self, record: logging.LogRecord) -> str:
        line = super().format(record)
        extras = " ".join(f"{k}={v}" for k, v in _extra_fields(record).items())
        return f"{line} {extras}" if extras else line


class _AppHandler(logging.StreamHandler):
    """Marks the handler this module installs, so setting up again replaces only it."""


def configure_logging(level: str, log_format: str) -> None:
    logging.setLogRecordFactory(_record_with_request_id)
    handler = _AppHandler(sys.stdout)
    handler.setFormatter(JsonFormatter() if log_format == "json" else TextFormatter())
    root = logging.getLogger()
    root.handlers = [h for h in root.handlers if not isinstance(h, _AppHandler)] + [handler]
    root.setLevel(level)
    # The request middleware logs each request with its timing; skip uvicorn's duplicate line.
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    for name in ("uvicorn", "uvicorn.error"):
        logging.getLogger(name).handlers = []
        logging.getLogger(name).propagate = True
