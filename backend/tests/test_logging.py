import json
import logging

from conftest import auth_header, onboard

from app.core.logging import JsonFormatter


def test_request_log_line_has_request_id_and_status(client, caplog):
    caplog.set_level(logging.INFO)
    response = client.get(
        "/api/v1/me", headers={**auth_header("lan@example.com"), "X-Request-ID": "req-123"}
    )
    assert response.status_code == 200
    done = [r for r in caplog.records if r.getMessage() == "request.completed"]
    assert done[-1].request_id == "req-123"
    assert (done[-1].method, done[-1].path, done[-1].status) == ("GET", "/api/v1/me", 200)
    assert done[-1].duration_ms >= 0


def test_rejected_token_is_logged_without_the_token(client, caplog):
    caplog.set_level(logging.INFO)
    response = client.get("/api/v1/me", headers={"Authorization": "Bearer not-a-real-token"})
    assert response.status_code == 401
    messages = [r.getMessage() for r in caplog.records]
    assert "request.rejected" in messages
    assert all("not-a-real-token" not in str(vars(r)) for r in caplog.records)


def test_company_requests_are_tied_to_the_company(client, caplog):
    headers = onboard(client, "lan@example.com")
    caplog.set_level(logging.INFO)
    client.get("/api/v1/orders", headers=headers)
    done = [r for r in caplog.records if r.getMessage() == "request.completed"][-1]
    assert done.company_id and done.user_id


def test_json_lines_carry_severity_request_id_and_fields():
    record = logging.makeLogRecord(
        {"name": "app.test", "levelname": "INFO", "msg": "trade_map.built", "orders": 3}
    )
    record.request_id = "abc"
    line = json.loads(JsonFormatter().format(record))
    assert line["severity"] == "INFO"
    assert line["message"] == "trade_map.built"
    assert line["requestId"] == "abc"
    assert line["orders"] == 3


def test_uvicorn_colour_copy_of_the_message_is_dropped():
    record = logging.makeLogRecord(
        {
            "name": "uvicorn.error",
            "levelname": "INFO",
            "msg": "Started server process [%d]",
            "args": (42,),
            "color_message": "Started server process [\x1b[36m%d\x1b[0m]",
        }
    )
    record.request_id = "-"
    line = json.loads(JsonFormatter().format(record))
    assert line["message"] == "Started server process [42]"
    assert "color_message" not in line
