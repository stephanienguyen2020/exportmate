"""Rules the browser demo repeats, checked against the cases in shared/parity/. The frontend's
tests (frontend/tests/parity.spec.ts) run the same files through its own copies, so the two
can't drift apart without a failing test."""

import json
from pathlib import Path

import pytest

from app.services.order_csv import parse_order_csv
from app.services.trade_map import parse_destination

PARITY = Path(__file__).resolve().parents[2] / "shared" / "parity"


def cases(name: str) -> list[dict]:
    return json.loads((PARITY / name).read_text())["cases"]


@pytest.mark.parametrize("case", cases("order-csv.json"), ids=lambda c: c["case"])
def test_order_csv_errors(case):
    parsed = parse_order_csv(case["csv"].encode(), default_currency="USD", max_rows=10_000)
    assert [e.message for e in parsed.errors] == case["errors"]


@pytest.mark.parametrize("case", cases("destinations.json"), ids=lambda c: c["destination"])
def test_destination_country(case):
    assert parse_destination(case["destination"])[1] == case["country"]
