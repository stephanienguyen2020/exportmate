"""Property-based tests (Hypothesis): rules that must hold for every input, not just examples."""

import csv
import io
import json
import math
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import pytest
from hypothesis import HealthCheck, assume, given, settings
from hypothesis import strategies as st

from app.core.currencies import ISO_CURRENCIES, is_currency
from app.services.order_csv import REQUIRED_COLUMNS, _parse_value_minor, parse_order_csv
from app.services.trade_map import (
    EARTH_RADIUS_KM,
    distance_km,
    km_from_extent,
    supplier_name_key,
)

# The autouse database fixtures run once per test, not per example.
settings.register_profile(
    "default", suppress_health_check=[HealthCheck.function_scoped_fixture], deadline=None
)
settings.load_profile("default")

VALUE_CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "testdata" / "order-values.json").read_text()
)


# --- Order values: the same answers as the browser demo (frontend/src/order-csv.ts) ---------


@pytest.mark.parametrize("text", VALUE_CASES["valid"])
def test_shared_valid_values(text):
    assert _parse_value_minor(text) is not None


@pytest.mark.parametrize("text", VALUE_CASES["invalid"])
def test_shared_invalid_values(text):
    assert _parse_value_minor(text) is None


@given(st.integers(min_value=1, max_value=10**14 - 1))
def test_every_cent_amount_reads_back_exactly(cents):
    text = f"{cents // 100}.{cents % 100:02d}"
    assert _parse_value_minor(text) == cents
    grouped = f"{cents // 100:,}.{cents % 100:02d}"
    assert _parse_value_minor(grouped) == cents


@given(st.integers(min_value=0, max_value=10**9), st.integers(min_value=1, max_value=9))
def test_a_third_decimal_is_refused(whole, digit):
    assert _parse_value_minor(f"{whole}.00{digit}") is None


@given(st.text().filter(lambda s: any(c not in "0123456789.,+-eE" for c in s)))
def test_text_outside_the_number_grammar_is_refused(text):
    assert _parse_value_minor(text) is None


# --- Whole CSV files ------------------------------------------------------------------------

cell_text = st.text(
    alphabet=st.characters(codec="utf-8", exclude_categories=["Cs", "Cc", "Zs", "Zl", "Zp"]),
    min_size=1,
    max_size=40,
)
valid_order = st.fixed_dictionaries(
    {
        "product": cell_text,
        "supplier": cell_text,
        "destination": cell_text,
        "value_minor": st.integers(min_value=1, max_value=10**14 - 1),
        "ship_date": st.dates(min_value=date(2000, 1, 1), max_value=date(2099, 12, 31)),
        "hs_code": st.sampled_from(["", "4407", "4407.11", "440711", "0401.10.00"]),
        "currency": st.sampled_from(["USD", "eur", "VND", ""]),
    }
)


def write_csv(orders: list[dict]) -> bytes:
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow([*REQUIRED_COLUMNS, "currency"])
    for i, o in enumerate(orders):
        minor = o["value_minor"]
        writer.writerow(
            [
                f"PO-{i}",
                o["product"],
                o["supplier"],
                o["destination"],
                f"{minor // 100}.{minor % 100:02d}",
                o["ship_date"].isoformat(),
                o["hs_code"],
                o["currency"],
            ]
        )
    return out.getvalue().encode()


@given(st.lists(valid_order, min_size=1, max_size=15))
def test_valid_orders_survive_a_csv_round_trip(orders):
    parsed = parse_order_csv(write_csv(orders), default_currency="SGD", max_rows=100)
    assert parsed.errors == []
    assert [r.row_number for r in parsed.rows] == list(range(2, len(orders) + 2))
    for row, o in zip(parsed.rows, orders, strict=True):
        assert row.order is not None
        assert row.order["product"] == o["product"].strip()
        assert row.order["value_minor"] == o["value_minor"]
        assert row.order["ship_date"] == o["ship_date"]
        assert row.order["hs_code"] == o["hs_code"]
        assert row.order["currency"] == (o["currency"] or "SGD").upper()


@given(
    st.lists(
        st.tuples(
            st.sampled_from(["A", "B", "C", " A "]),
            st.sampled_from(["100", "1,250.50", "abc", "-3", "0.001", ""]),
        ),
        max_size=25,
    )
)
def test_each_row_is_accepted_or_explained_and_ids_stay_unique(rows):
    lines = [",".join(REQUIRED_COLUMNS)] + [
        f"{rid},Item,Maker,Hamburg,{value},2026-10-27,4407" for rid, value in rows
    ]
    parsed = parse_order_csv("\n".join(lines).encode(), default_currency="USD", max_rows=100)
    ids = [r.order["external_id"] for r in parsed.valid_rows]
    assert len(ids) == len(set(ids))
    explained = {e.row for e in parsed.errors if e.row is not None}
    for row in parsed.rows:
        assert (row.order is None) == (row.row_number in explained)


@given(st.integers(min_value=1, max_value=30), st.integers(min_value=1, max_value=30))
def test_row_limit(count, limit):
    content = write_csv(
        [
            {
                "product": "x",
                "supplier": "y",
                "destination": "z",
                "value_minor": 100,
                "ship_date": date(2026, 1, 1),
                "hs_code": "",
                "currency": "",
            }
        ]
        * count
    )
    parsed = parse_order_csv(content, default_currency="USD", max_rows=limit)
    assert len(parsed.rows) == min(count, limit)
    assert (count > limit) == any("Too many rows" in e.message for e in parsed.errors)


# --- Small helpers --------------------------------------------------------------------------


@given(st.text(min_size=3, max_size=3))
def test_is_currency_is_exactly_the_iso_list(code):
    assert is_currency(code) == (code in ISO_CURRENCIES)


@given(st.text())
def test_supplier_key_is_idempotent_and_ignores_spacing_and_case(name):
    key = supplier_name_key(name)
    assert supplier_name_key(key) == key
    assert supplier_name_key(f"  {name.upper()}\t") == supplier_name_key(name.upper())
    assert "  " not in key and key == key.strip()


lat = st.floats(min_value=-80, max_value=80)
lon = st.floats(min_value=-180, max_value=180)


@given(lat, lon, lat, lon, lat, lon)
def test_distance_is_a_metric(lat1, lon1, lat2, lon2, lat3, lon3):
    ab = distance_km(lat1, lon1, lat2, lon2)
    assert distance_km(lat1, lon1, lat1, lon1) == pytest.approx(0, abs=1e-6)
    assert ab == pytest.approx(distance_km(lat2, lon2, lat1, lon1))
    assert 0 <= ab <= math.pi * EARTH_RADIUS_KM + 1e-6
    assert ab <= distance_km(lat1, lon1, lat3, lon3) + distance_km(lat3, lon3, lat2, lon2) + 1e-6


def square(center_lon: float, center_lat: float, half: float, hole: float = 0) -> SimpleNamespace:
    def ring(h: float) -> list[list[float]]:
        c = [(-h, -h), (h, -h), (h, h), (-h, h), (-h, -h)]
        return [[center_lon + x, center_lat + y] for x, y in c]

    rings = [ring(half)] + ([ring(hole)[::-1]] if hole else [])
    return SimpleNamespace(
        center_longitude=center_lon,
        center_latitude=center_lat,
        extent={"type": "Polygon", "coordinates": rings},
    )


center_lon = st.floats(min_value=-179, max_value=179)
center_lat = st.floats(min_value=-60, max_value=60)
half = st.floats(min_value=0.05, max_value=0.5)
offset = st.floats(min_value=-0.99, max_value=0.99)


@given(center_lon, center_lat, half, offset, offset)
def test_a_point_inside_the_extent_is_zero_km_away(clon, clat, h, fx, fy):
    flood = square(clon, clat, h)
    assert km_from_extent(flood, clat + fy * h, clon + fx * h) == 0.0


@given(center_lon, center_lat, half, st.floats(min_value=0.01, max_value=2))
def test_distance_north_of_the_extent_is_the_gap(clon, clat, h, gap):
    flood = square(clon, clat, h)
    km = km_from_extent(flood, clat + h + gap, clon)
    assert km == pytest.approx(gap * math.pi / 180 * EARTH_RADIUS_KM, rel=0.02)


@given(center_lon, center_lat, half)
def test_a_point_in_a_hole_is_outside(clon, clat, h):
    flood = square(clon, clat, h, hole=h / 2)
    assert km_from_extent(flood, clat, clon) > 0


@given(center_lat, half, offset, offset, st.sampled_from([-360, 360]))
def test_extents_across_the_antimeridian(clat, h, fx, fy, shift):
    assume(abs(fx) < 0.95 and abs(fy) < 0.95)
    flood = square(180 - h / 2, clat, h)
    point_lon = 180 - h / 2 + fx * h
    inside = km_from_extent(flood, clat + fy * h, point_lon)
    assert inside == 0.0
    assert km_from_extent(flood, clat + fy * h, point_lon + shift) == 0.0
