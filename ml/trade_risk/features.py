"""Feature table: one row per (market, exporter, HS 6 product, year) with imports of at least $1 million.

    uv run python -m trade_risk.features   # needs cases.parquet, trade_flows.parquet, exporter_totals.parquet

The label `case_opened_next_year` is 1 when the market opened an anti-dumping or anti-subsidy case
against the exporter on the product in the following year. Every feature uses only what was known
at the end of the row's year: that year's trade figures and the cases opened up to then.
Feature meanings: ml/docs/TRADE_DEFENCE_RISK_MODEL.md ("Build features").
"""

import numpy as np
import pandas as pd

from trade_risk.common import (
    CASES_FILE,
    EXPORTER_TOTALS_FILE,
    FEATURES_FILE,
    FIRST_TRADE_YEAR,
    LAST_TRADE_YEAR,
    MIN_FLOW_USD,
    TRADE_FLOWS_FILE,
)

KEY = ["market", "exporter", "hs6"]
LABEL = "case_opened_next_year"
TRADE_FEATURES = [
    "import_value_usd",
    "market_import_value_usd",
    "import_value_vs_last_year",
    "import_value_vs_3_years_ago",
    "import_tonnes_vs_last_year",
    "is_new_flow",
    "exporter_share_of_market",
    "exporter_share_change_1y",
    "exporter_share_change_3y",
    "unit_price_vs_last_year",
    "unit_price_vs_market_average",
    "market_imports_vs_last_year",
    "market_imports_vs_3_years_ago",
    "import_growth_vs_market_growth",
    "exporter_rank_in_market",
    "market_supplier_count",
    "exporter_world_exports_vs_last_year",
    "exporter_share_of_world_exports",
    "hs_chapter",
]
HISTORY_FEATURES = [
    "past_cases_same_market_exporter_product",
    "years_since_last_case_same_market_exporter_product",
    "measure_in_force_same_market_exporter_product",
    "market_duties_in_force_on_product_against_others",
    "market_duties_in_force_on_heading_against_others",
    "market_cases_on_product_last_5y",
    "market_cases_on_heading_last_2y",
    "other_exporters_cased_on_product_last_2y",
    "other_markets_casing_exporter_last_2y",
    "market_cases_against_exporter_last_5y",
    "cases_on_product_all_markets_last_2y",
    "cases_against_exporter_all_markets_last_5y",
    "market_cases_opened_this_year",
    "market_cases_opened_last_3y",
]
FEATURES = TRADE_FEATURES + HISTORY_FEATURES
# The features of the design's first list (the baseline of 23 Nov 2026), for comparison.
BASELINE_FEATURES = [
    "import_value_usd", "market_import_value_usd", "import_value_vs_last_year", "import_value_vs_3_years_ago",
    "import_tonnes_vs_last_year", "is_new_flow", "exporter_share_of_market", "exporter_share_change_1y",
    "exporter_share_change_3y", "unit_price_vs_last_year", "unit_price_vs_market_average",
    "market_imports_vs_last_year", "market_imports_vs_3_years_ago", "hs_chapter",
    "past_cases_same_market_exporter_product", "market_cases_on_product_last_5y",
    "other_exporters_cased_on_product_last_2y", "other_markets_casing_exporter_last_2y", "market_cases_opened_this_year",
]
# Case lists are complete to the end of 2024 (TTBD; it misses some late-2024 cases outside the US)
# and, for the US only, to today (Federal Register).
LAST_CASE_YEAR = 2024
LAST_US_CASE_YEAR = 2025  # 2026 is still running
# A duty whose end TTBD doesn't record counts as in force this long after it was imposed: five
# years, renewed once at the sunset review.
UNKNOWN_END_YEARS = 10


def ratio(numerator: np.ndarray, denominator: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        result = numerator / denominator
    result[~np.isfinite(result)] = np.nan
    return result


def column(wide: pd.DataFrame, year: int, index: pd.Index) -> np.ndarray:
    if year not in wide.columns:
        return np.full(len(index), np.nan)
    return wide[year].reindex(index).to_numpy(dtype="float64")


def trade_features(trade: pd.DataFrame, exporter_totals: pd.DataFrame, years=None) -> pd.DataFrame:
    """One row per flow of at least $1M in each of `years` (default: every BACI year with a year
    before it). A year's growth features need the year before it and three years before it."""
    value = trade.set_index(KEY + ["year"])["value_usd"].unstack("year")
    tonnes = trade.set_index(KEY + ["year"])["tonnes"].unstack("year")
    market_value = trade.groupby(["market", "hs6", "year"])["value_usd"].sum().unstack("year")
    priced = trade.dropna(subset=["tonnes"])
    market_priced = priced.groupby(["market", "hs6", "year"])[["value_usd", "tonnes"]].sum()
    market_unit_price = (market_priced["value_usd"] / market_priced["tonnes"]).unstack("year")
    ranks = trade.assign(
        exporter_rank_in_market=trade.groupby(["market", "hs6", "year"])["value_usd"].rank(ascending=False, method="min"),
        market_supplier_count=trade.groupby(["market", "hs6", "year"])["value_usd"].transform("size"),
    ).set_index(KEY + ["year"])[["exporter_rank_in_market", "market_supplier_count"]]
    world_by_exporter = exporter_totals.set_index(["exporter", "hs6", "year"])["world_value_usd"].unstack("year")
    world_by_product = exporter_totals.groupby(["hs6", "year"])["world_value_usd"].sum().unstack("year")

    frames = []
    for year in years or range(FIRST_TRADE_YEAR + 1, LAST_TRADE_YEAR + 1):
        if year not in value.columns:
            continue
        current = value[year].dropna()
        current = current[current >= MIN_FLOW_USD]
        frame = current.rename("import_value_usd").reset_index()
        index = pd.MultiIndex.from_frame(frame[KEY])
        by_market = pd.MultiIndex.from_frame(frame[["market", "hs6"]])
        by_exporter = pd.MultiIndex.from_frame(frame[["exporter", "hs6"]])
        v0, v1, v3 = frame["import_value_usd"].to_numpy(), column(value, year - 1, index), column(value, year - 3, index)
        q0, q1 = column(tonnes, year, index), column(tonnes, year - 1, index)
        m0, m1, m3 = (column(market_value, y, by_market) for y in (year, year - 1, year - 3))
        share0, share1, share3 = ratio(v0, m0), ratio(np.nan_to_num(v1), m1), ratio(np.nan_to_num(v3), m3)
        e0, e1 = column(world_by_exporter, year, by_exporter), column(world_by_exporter, year - 1, by_exporter)
        frame["year"] = year
        frame["market_import_value_usd"] = m0
        frame["import_value_vs_last_year"] = ratio(v0, v1)
        frame["import_value_vs_3_years_ago"] = ratio(v0, v3)
        frame["import_tonnes_vs_last_year"] = ratio(q0, q1)
        frame["is_new_flow"] = (np.nan_to_num(v1) <= 0).astype("float64")
        frame["exporter_share_of_market"] = share0
        frame["exporter_share_change_1y"] = share0 - share1
        frame["exporter_share_change_3y"] = share0 - share3
        frame["unit_price_vs_last_year"] = ratio(ratio(v0, q0), ratio(v1, q1))
        frame["unit_price_vs_market_average"] = ratio(ratio(v0, q0), column(market_unit_price, year, by_market))
        frame["market_imports_vs_last_year"] = ratio(m0, m1)
        frame["market_imports_vs_3_years_ago"] = ratio(m0, m3)
        frame["import_growth_vs_market_growth"] = ratio(frame["import_value_vs_last_year"].to_numpy(), frame["market_imports_vs_last_year"].to_numpy())
        frame["exporter_world_exports_vs_last_year"] = ratio(e0, e1)
        frame["exporter_share_of_world_exports"] = ratio(e0, column(world_by_product, year, pd.Index(frame["hs6"])))
        frame["hs_chapter"] = frame["hs6"].str[:2].astype("int16")
        frames.append(frame)
        if years is None:
            print(f"  {year}: {len(frame):,} rows", flush=True)
    if not frames:
        return pd.DataFrame(columns=KEY + ["year", *TRADE_FEATURES])
    panel = pd.concat(frames, ignore_index=True)
    return panel.merge(ranks.reset_index(), on=KEY + ["year"], how="left")


def count_by(cases: pd.DataFrame, keys: list[str], name: str, what: str = "case_id") -> pd.Series:
    return cases.groupby(keys)[what].nunique().rename(name)


def duties_in_force(known: pd.DataFrame, year: int) -> pd.DataFrame:
    """Cases whose duty was in force at the end of `year`."""
    end = pd.Timestamp(f"{year}-12-31")
    imposed = known[known["final_measure_on"] <= end]
    status = imposed["measure_status"]
    still = ((status == "in force")
             | ((status == "revoked") & (imposed["revoked_on"] > end))
             | ((status == "end unknown") & (imposed["final_measure_on"] > end - pd.DateOffset(years=UNKNOWN_END_YEARS))))
    return imposed[still]


def history_features(panel_year: pd.DataFrame, cases: pd.DataFrame, year: int) -> pd.DataFrame:
    known = cases[cases["year"] <= year]
    last_2y = known[known["year"] > year - 2]
    last_3y = known[known["year"] > year - 3]
    last_5y = known[known["year"] > year - 5]
    in_force = duties_in_force(known, year).assign(hs4=lambda d: d["hs6"].str[:4])
    same_flow = known.groupby(KEY).agg(past=("case_id", "nunique"), last_year=("year", "max"))

    frame = panel_year.merge(same_flow.reset_index(), on=KEY, how="left")
    frame["past_cases_same_market_exporter_product"] = frame.pop("past").fillna(0)
    frame["years_since_last_case_same_market_exporter_product"] = year - frame.pop("last_year")
    flow_in_force = in_force[KEY].drop_duplicates().assign(measure_in_force_same_market_exporter_product=1.0)
    frame = frame.merge(flow_in_force, on=KEY, how="left")
    # Duties in force on the product, or on related products, against other exporters: their trade
    # moves to the exporters left, who are then cased too.
    frame["hs4"] = frame["hs6"].str[:4]
    frame = frame.merge(count_by(in_force, ["market", "hs6"], "duties_on_product", "exporter").reset_index(), on=["market", "hs6"], how="left")
    frame = frame.merge(count_by(in_force, ["market", "hs4"], "duties_on_heading", "exporter").reset_index(), on=["market", "hs4"], how="left")
    own_heading = in_force[["market", "exporter", "hs4"]].drop_duplicates().assign(own_heading_duty=1.0)
    frame = frame.merge(own_heading, on=["market", "exporter", "hs4"], how="left")
    frame["market_duties_in_force_on_product_against_others"] = (
        frame.pop("duties_on_product").fillna(0) - frame["measure_in_force_same_market_exporter_product"].fillna(0))
    frame["market_duties_in_force_on_heading_against_others"] = (
        frame.pop("duties_on_heading").fillna(0) - frame.pop("own_heading_duty").fillna(0))
    frame = frame.drop(columns="hs4")
    cased_recently = last_2y[KEY].drop_duplicates().assign(cased_last_2y=1.0)
    frame = frame.merge(cased_recently, on=KEY, how="left")
    lookups = [
        (count_by(last_5y, ["market", "hs6"], "market_cases_on_product_last_5y"), ["market", "hs6"]),
        (count_by(last_2y.assign(hs4=last_2y["hs6"].str[:4]), ["market", "hs4"], "market_cases_on_heading_last_2y"), ["market", "hs4"]),
        (count_by(last_2y, ["market", "hs6"], "exporters_cased_on_product_last_2y", "exporter"), ["market", "hs6"]),
        (count_by(last_2y, ["exporter", "hs6"], "markets_casing_exporter_last_2y", "market"), ["exporter", "hs6"]),
        (count_by(last_5y, ["market", "exporter"], "market_cases_against_exporter_last_5y"), ["market", "exporter"]),
        (count_by(last_2y, ["hs6"], "cases_on_product_all_markets_last_2y"), ["hs6"]),
        (count_by(last_5y, ["exporter"], "cases_against_exporter_all_markets_last_5y"), ["exporter"]),
        (count_by(known[known["year"] == year], ["market"], "market_cases_opened_this_year"), ["market"]),
        (count_by(last_3y, ["market"], "market_cases_opened_last_3y"), ["market"]),
    ]
    frame["hs4"] = frame["hs6"].str[:4]
    for counts, keys in lookups:
        frame = frame.merge(counts.reset_index(), on=keys, how="left")
    frame = frame.drop(columns="hs4")
    counted = [c for c in frame.columns if c.endswith(("_last_2y", "_last_3y", "_last_5y", "_this_year", "_in_force_same_market_exporter_product"))]
    frame[counted] = frame[counted].fillna(0)
    # "Other" exporters and markets: leave this flow's own case out of the count.
    frame["other_exporters_cased_on_product_last_2y"] = frame.pop("exporters_cased_on_product_last_2y") - frame["cased_last_2y"]
    frame["other_markets_casing_exporter_last_2y"] = frame.pop("markets_casing_exporter_last_2y") - frame.pop("cased_last_2y")
    return frame


def labels(frame: pd.DataFrame, cases: pd.DataFrame, year: int) -> pd.DataFrame:
    opened = cases[cases["year"] == year + 1][KEY].drop_duplicates().assign(**{LABEL: 1})
    frame = frame.merge(opened, on=KEY, how="left")
    frame[LABEL] = frame[LABEL].fillna(0).astype("int8")
    complete_for_all = year + 1 <= LAST_CASE_YEAR
    frame["label_known"] = complete_for_all | ((frame["market"] == "USA") & (year + 1 <= LAST_US_CASE_YEAR))
    return frame


def positive_coverage(trade: pd.DataFrame, cases: pd.DataFrame) -> None:
    """How many next-year cases sit on a flow of at least $1 million (the rows the model sees)."""
    value = trade.set_index(KEY + ["year"])["value_usd"]
    targets = cases[cases["year"].between(FIRST_TRADE_YEAR + 2, LAST_TRADE_YEAR + 1)][KEY + ["year"]].drop_duplicates()
    targets["year"] = targets["year"] - 1
    found = value.reindex(pd.MultiIndex.from_frame(targets)).to_numpy()
    for threshold in (1, 250_000, MIN_FLOW_USD):
        print(f"  cases on a flow of at least ${threshold:,} the year before: {np.mean(np.nan_to_num(found) >= threshold):.0%}")


def main() -> None:
    cases = pd.read_parquet(CASES_FILE)
    trade = pd.read_parquet(TRADE_FLOWS_FILE)
    exporter_totals = pd.read_parquet(EXPORTER_TOTALS_FILE)
    print("label coverage:")
    positive_coverage(trade, cases)
    print("trade features:")
    panel = trade_features(trade, exporter_totals)
    del trade
    parts = []
    for year, panel_year in panel.groupby("year"):
        parts.append(labels(history_features(panel_year, cases, year), cases, year))
    panel = pd.concat(parts, ignore_index=True)
    float_columns = [c for c in FEATURES if c != "hs_chapter"]
    panel[float_columns] = panel[float_columns].astype("float32")
    panel = panel[KEY + ["year"] + FEATURES + [LABEL, "label_known"]]
    panel.to_parquet(FEATURES_FILE, index=False)
    summary = panel.groupby("year").agg(rows=(LABEL, "size"), cases=(LABEL, "sum"), labels_known=("label_known", "mean"))
    print(f"wrote {FEATURES_FILE}: {len(panel):,} rows, {len(FEATURES)} features\n{summary.to_string()}")


if __name__ == "__main__":
    main()
