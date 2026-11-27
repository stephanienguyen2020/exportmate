"""Pure parts of the Order features job: month windows and reason wording."""

from datetime import date

import numpy as np
import pandas as pd

from trade_risk.order_features import months_back, reasons_for, shift_month, windows


def test_months_back_crosses_years():
    assert months_back(date(2026, 2, 1), 4) == ["202511", "202512", "202601", "202602"]
    assert shift_month("202601", -1) == "202512"
    assert shift_month("202512", 13) == "202701"


def test_windows_need_the_latest_two_years_complete():
    months = set(months_back(date(2026, 8, 1), 48))
    found = windows(months, today=date(2026, 11, 25))
    assert found[0][0] == "202509" and found[0][-1] == "202608"
    assert found[1][-1] == "202508" and found[3][0] == "202209"
    assert windows(months - {"202512"}, today=date(2026, 11, 25)) is None  # a gap in the latest 12


def test_windows_too_old_fall_back():
    months = set(months_back(date(2025, 6, 1), 48))
    assert windows(months, today=date(2026, 11, 25)) is None


def test_reasons_never_quote_dollar_figures():
    features = ["import_value_usd", "import_value_vs_last_year", "market_import_value_usd"]
    row = pd.Series({"market": "USA", "exporter": "VNM", "hs6": "441231", "import_value_usd": 40e6,
                     "import_value_vs_last_year": 4.0, "market_import_value_usd": 210e6})
    reasons = reasons_for(row, np.array([0.5, 0.4, 0.3]), features, {"USA": "the US", "VNM": "Vietnam"})
    texts = [r["text"] for r in reasons]
    assert texts == ["Vietnam is a large supplier of it to the US", "Imports grew 4.0× in a year",
                     "The US is a large importer of it"]
    assert not any("$" in t for t in texts)


def test_reasons_skip_what_lowered_the_score():
    row = pd.Series({"market": "USA", "exporter": "VNM", "hs6": "441231", "import_value_vs_last_year": 4.0})
    assert reasons_for(row, np.array([-0.2]), ["import_value_vs_last_year"], {}) == []
