import math

import pandas as pd

from trade_risk.harshness import market_shape
from trade_risk.harshness_scoring import MAX_ROWS, Measure, measure_rows
from trade_risk.order_features import Countries, Pair

COUNTRIES = Countries(
    iso3_of={"US": "USA", "VN": "VNM", "CN": "CHN", "ID": "IDN", "MY": "MYS", "IN": "IND"},
    iso2_of={"USA": "US", "VNM": "VN", "CHN": "CN", "IDN": "ID", "MYS": "MY", "IND": "IN"},
    numeric_of={}, iso3_of_numeric={}, names={},
)
US_IMPORTS = pd.DataFrame([
    {"exporter": "VNM", "hs6": "441231", "value_usd": 900e6},
    {"exporter": "VNM", "hs6": "441233", "value_usd": 300e6},
    {"exporter": "CHN", "hs6": "441231", "value_usd": 500e6},
    {"exporter": "IDN", "hs6": "441231", "value_usd": 200e6},
    {"exporter": "MYS", "hs6": "441294", "value_usd": 50e6},
])


def measure(**fields) -> Measure:
    base = {"article_id": "a1", "kind": "anti_dumping", "stage": "opening", "markets": ("US",), "origins": ("VN",),
            "product_hs": ("441231",)}
    return Measure(**{**base, **fields})


def test_a_measure_is_read_from_the_scans_json():
    text = '{"articleId": "abc", "kind": "safeguard", "markets": ["in"], "productHs": ["7209.17"]}'
    assert Measure.from_json(text) == Measure("abc", "safeguard", "unknown", ("IN",), (), ("720917",))


def test_a_heading_becomes_the_codes_the_market_imports_most_from_the_origins():
    rows, skipped = measure_rows(measure(product_hs=("4412",)), COUNTRIES, lambda market: US_IMPORTS)
    assert [r.pair for r in rows] == [Pair("US", "VN", "441231"), Pair("US", "VN", "441233")]
    assert skipped == []


def test_a_measure_on_every_country_is_scored_for_the_biggest_suppliers():
    rows, _ = measure_rows(measure(kind="safeguard", origins=()), COUNTRIES, lambda market: US_IMPORTS)
    assert [r.exporter for r in rows] == ["VNM", "CHN", "IDN"]


def test_unknown_codes_are_left_out_and_said_why():
    rows, skipped = measure_rows(measure(markets=("US", "XX"), origins=("VN", "ZZ"), product_hs=("9999",)), COUNTRIES,
                                 lambda market: US_IMPORTS)
    assert rows == []
    assert skipped == ["unknown origin ZZ", "no imports under HS 9999", "unknown market XX"]


def test_rows_stop_at_the_limit():
    many = pd.DataFrame([{"exporter": "CHN", "hs6": f"4412{n:02d}", "value_usd": 1e6} for n in range(30)])
    rows, skipped = measure_rows(measure(origins=("CN",), product_hs=tuple(f"4412{n:02d}" for n in range(30))), COUNTRIES,
                                 lambda market: many)
    assert len(rows) == MAX_ROWS and skipped == [f"{30 - MAX_ROWS} rows over the limit of {MAX_ROWS}"]


def test_the_market_shape_of_a_case():
    flows = {"VNM": 60.0, "CHN": 20.0, "IDN": 15.0, "MYS": 5.0}
    named, own, top_rest, rest_over_1pct = market_shape(flows, {"VNM", "CHN"}, "VNM")
    assert (named, own, top_rest, rest_over_1pct) == (0.8, 0.75, 0.15, 2.0)
    # A safeguard names everyone: no rest of the market.
    assert market_shape(flows, {"ALL"}, "VNM")[0] == 1.0
    assert all(math.isnan(x) for x in market_shape({}, {"VNM"}, "VNM"))
