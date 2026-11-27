"""Harshness model (severity model v2): how badly will a new anti-dumping, anti-subsidy or safeguard case
hurt trade on its market, origin and product? Design: ml/docs/HARSHNESS_MODEL.md; results: ml/docs/HARSHNESS_RESULTS.md.

    uv run python -m trade_risk.harshness_cases build   # first: the case table with outcomes
    uv run python -m trade_risk.harshness build         # rows, labels and features -> data/interim/trade_risk/harshness.parquet
    uv run python -m trade_risk.harshness tune          # model settings, picked on 2015-2017 (before every test year)
    uv run python -m trade_risk.harshness compare       # walk-forward test of every label, against simple baselines

One row per (case, market, origin, HS 6) opened 2013-2025, dated the day the case was opened (a
safeguard: one row per the market's biggest suppliers). Features: the trade risk model's features for
the year before the opening (trade flow and case history), plus what is known about the case on that
day. Labels, what happened after (missing when not known yet):
- ended_in_duty: the case reached a final duty (TTBD, WTO portal or EU TRON; pending cases have none).
- imports_fell: imports of the product from that origin into that market, in the best of the 2 years
  after the opening year, were at most half of the year before the opening (BACI; a flow that stopped
  counts as fallen).
- imports_fell_vs_rest: the same, against how imports from the origins no case named moved.
- both, both_vs_rest: a duty and the fall together.
Walk-forward: for each test year Y, train on cases opened 2013 to Y-1 and score the cases opened in Y.
"""

import argparse
import json
import os
from datetime import date

import numpy as np
import pandas as pd
import pyarrow.dataset as ds
from sklearn.metrics import average_precision_score, roc_auc_score

from trade_risk.common import FEATURES_FILE, INTERIM_DIR, LAST_TRADE_YEAR, MODELS_DIR, TRADE_FLOWS_FILE
from trade_risk.features import FEATURES
from trade_risk.harshness_cases import HARSHNESS_CASES_FILE
from trade_risk.train import BOOSTED_TREES, Ensemble, Model, metrics

HARSHNESS_FILE = INTERIM_DIR / "harshness.parquet"
RUN_DIR = MODELS_DIR.parent / "harshness" / os.environ.get("HARSHNESS_RUN", date.today().isoformat())
# Features need the year before the opening (BACI 2012-2024), so cases opened 2013-2025; the import labels
# need 2 years after, so only to 2022.
FIRST_YEAR, LAST_YEAR = 2013, LAST_TRADE_YEAR + 1
TEST_YEARS = {"ended_in_duty": (2018, 2019, 2020, 2021, 2022, 2023, 2024)}
IMPORT_TEST_YEARS = (2018, 2019, 2020, 2021, 2022)
# A safeguard names no origin: it is scored for the market's biggest suppliers of the product.
SAFEGUARD_TOP_ORIGINS = 10
FALL_SHARE = 0.5
LABELS = ("ended_in_duty", "imports_fell", "imports_fell_vs_rest", "both", "both_vs_rest")
REST_MIN_USD = 1_000_000  # the rest of the market must be at least this big the year before to compare with
# Outcomes of earlier cases count only once they could be known: a final duty comes 12-18 months after
# the opening, so a market's record uses cases opened at least 2 years before.
OUTCOME_LAG_DAYS = 730
CASE_FEATURES = [
    "is_anti_subsidy",
    "is_safeguard",
    "origins_in_investigation",
    "products_in_investigation",
    "market_duty_rate_before",
    "market_kind_duty_rate_before",
    "origin_duty_rate_before",
    "market_cases_before",
    "market_chapter_duty_rate_before",
]
# The market the year before the opening (BACI): how much of it the case names, and who else could supply it.
MARKET_SHAPE_FEATURES = ["named_share_of_market", "own_share_of_named", "top_rest_share_of_market", "rest_suppliers_over_1pct"]
# How often imports fell after earlier cases (imports_fell_vs_rest, each case counted once), known only
# once their 2 years after have passed.
PAST_FALL_FEATURES = ["market_fall_rate_before", "origin_fall_rate_before", "chapter_fall_rate_before", "market_fall_cases_before"]
NEW_FEATURES = MARKET_SHAPE_FEATURES + PAST_FALL_FEATURES
TUNE_LABELS = ("imports_fell_vs_rest", "ended_in_duty")
TUNE_VALID_YEARS = (2015, 2016, 2017)  # before every test year
TUNE_TRIALS = 20
TUNED_FILE = RUN_DIR / "tuned.json"
# Model settings: the trade risk model's defaults, smaller (there are far fewer rows).
PARAMS = {
    "lightgbm": {"n_estimators": 300, "learning_rate": 0.03, "num_leaves": 15, "min_child_samples": 40,
                 "subsample": 0.8, "colsample_bytree": 0.8},
    "xgboost": {"n_estimators": 300, "learning_rate": 0.03, "max_depth": 4, "min_child_weight": 5,
                "subsample": 0.8, "colsample_bytree": 0.8},
    "catboost": {"iterations": 400, "learning_rate": 0.05, "depth": 5},
}


# ---------------------------------------------------------------- build

def case_rows() -> pd.DataFrame:
    cases = pd.read_parquet(HARSHNESS_CASES_FILE)
    cases = cases[cases["year"].between(FIRST_YEAR, LAST_YEAR)].copy()
    cases["is_anti_subsidy"] = cases["kind"].eq("CVD").astype("float32")
    cases["is_safeguard"] = cases["kind"].eq("SG").astype("float32")
    # One investigation: the same market opening cases on the same products on the same day, one case
    # per origin in TTBD.
    cases["investigation"] = cases["market"] + "|" + cases["opened_on"].dt.strftime("%Y-%m-%d") + "|" + cases["product"].fillna("")
    cases["origins_in_investigation"] = cases.groupby("investigation")["exporter"].transform("nunique").astype("float32")
    cases["products_in_investigation"] = cases.groupby("case_id")["hs6"].transform("nunique").astype("float32")
    # Pending cases (no decision known yet) have no label.
    cases["ended_in_duty"] = cases["outcome"].map({"duty": 1.0, "no_duty": 0.0})
    return cases


def past_duty_rates(cases: pd.DataFrame) -> pd.DataFrame:
    """For each case, the share of earlier cases (opened 2+ years before) that ended in a duty: in its
    market, in its market for the same kind, and against its origin anywhere. Every decided case counts."""
    history = pd.read_parquet(HARSHNESS_CASES_FILE)
    history = history[history["outcome"].ne("pending")].drop_duplicates("case_id")
    history["duty"] = history["outcome"].eq("duty").astype(float)
    history["known_from"] = history["opened_on"] + pd.to_timedelta(OUTCOME_LAG_DAYS, unit="D")
    history["chapter"] = history["hs6"].str[:2]  # a case's first product
    unique = cases.drop_duplicates("case_id").assign(chapter=lambda f: f["hs6"].str[:2])
    unique = unique[["case_id", "market", "kind", "exporter", "chapter", "opened_on"]]
    out = {}
    for name, keys in (("market", ["market"]), ("market_kind", ["market", "kind"]), ("origin", ["exporter"]),
                       ("market_chapter", ["market", "chapter"])):
        past = history[[*keys, "known_from", "duty"]].sort_values("known_from")
        now = unique[["case_id", *keys, "opened_on"]].sort_values("opened_on")
        past["count"] = 1.0
        grouped = past.groupby(keys)
        past["duties"] = grouped["duty"].cumsum()
        past["cases"] = grouped["count"].cumsum()
        joined = pd.merge_asof(now, past[[*keys, "known_from", "duties", "cases"]], left_on="opened_on",
                               right_on="known_from", by=keys, direction="backward", allow_exact_matches=False)
        out[f"{name}_duty_rate_before"] = (joined.set_index("case_id")["duties"] / joined.set_index("case_id")["cases"]).astype("float32")
        if name == "market":
            out["market_cases_before"] = joined.set_index("case_id")["cases"].fillna(0).astype("float32")
    return pd.DataFrame(out).reset_index().rename(columns={"index": "case_id"})


def past_fall_rates(rows: pd.DataFrame) -> pd.DataFrame:
    """For each case, the share of earlier cases whose named imports fell against the rest of the market
    (imports_fell_vs_rest, the case's average over its products): in its market, against its origin, and
    in its HS chapter. A case counts from the start of its opening year + 3, when its 2 years after are known."""
    labelled = rows[rows["imports_fell_vs_rest"].notna()].assign(chapter=lambda f: f["hs6"].str[:2])
    history = labelled.groupby("case_id").agg(market=("market", "first"), exporter=("exporter", "first"), chapter=("chapter", "first"),
                                              year=("year", "first"), fell=("imports_fell_vs_rest", "mean")).reset_index()
    history["known_from"] = pd.to_datetime((history["year"] + 3).astype(str) + "-01-01")
    unique = rows.drop_duplicates("case_id").assign(chapter=lambda f: f["hs6"].str[:2])[["case_id", "market", "exporter", "chapter", "opened_on"]]
    out = {}
    for name, keys in (("market", ["market"]), ("origin", ["exporter"]), ("chapter", ["chapter"])):
        past = history[[*keys, "known_from", "fell"]].sort_values("known_from")
        past["count"] = 1.0
        grouped = past.groupby(keys)
        past["falls"], past["cases"] = grouped["fell"].cumsum(), grouped["count"].cumsum()
        joined = pd.merge_asof(unique[["case_id", *keys, "opened_on"]].sort_values("opened_on"), past[[*keys, "known_from", "falls", "cases"]],
                               left_on="opened_on", right_on="known_from", by=keys, direction="backward", allow_exact_matches=False)
        joined = joined.set_index("case_id")
        out[f"{name}_fall_rate_before"] = (joined["falls"] / joined["cases"]).astype("float32")
        if name == "market":
            out["market_fall_cases_before"] = joined["cases"].fillna(0).astype("float32")
    return pd.DataFrame(out).rename_axis("case_id").reset_index()


def market_imports(cases: pd.DataFrame) -> pd.DataFrame:
    """BACI imports of the case products into the case markets from every origin, every year."""
    dataset = ds.dataset(TRADE_FLOWS_FILE)
    table = dataset.to_table(
        columns=["year", "market", "exporter", "hs6", "value_usd"],
        filter=ds.field("market").isin(sorted(cases["market"].unique())) & ds.field("hs6").isin(sorted(cases["hs6"].unique())),
    )
    return table.to_pandas().merge(cases[["market", "hs6"]].drop_duplicates(), on=["market", "hs6"])


def named_origins(cases: pd.DataFrame) -> dict[tuple, set]:
    """For each (market, HS 6, opening year), the origins any case named that year or the year before:
    parallel cases on the same goods are one action, and none of them is a comparison."""
    named: dict[tuple, set] = {}
    for (market, hs6, year), group in cases.groupby(["market", "hs6", "year"])["exporter"]:
        for y in (year, year + 1):
            named.setdefault((market, hs6, y), set()).update(group)
    return named


def import_changes(cases: pd.DataFrame, imports: pd.DataFrame, all_cases: pd.DataFrame) -> pd.DataFrame:
    """For each row: the named origin's imports the year before and the best of the 2 years after (no
    BACI row counts as 0: the flow stopped), and the same for the origins no case named (the rest of the
    market). Ratios are after / before. The year before is known on the opening day, so it also gives
    features: how much of the market the case names, and how many other suppliers could take its place."""
    by_origin_lookup = imports.groupby(["market", "hs6", "exporter", "year"])["value_usd"].sum().to_dict()
    total = imports.groupby(["market", "hs6", "year"])["value_usd"].sum().to_dict()
    per_market_origin = {key: dict(zip(g["exporter"], g["value_usd"])) for key, g in imports.groupby(["market", "hs6", "year"])}
    named = named_origins(all_cases)
    out = []
    for market, exporter, hs6, year in cases[["market", "exporter", "hs6", "year"]].itertuples(index=False):
        y = int(year)
        names = named.get((market, hs6, y), {exporter})
        before_total = total.get((market, hs6, y - 1), 0.0)
        before_flows = per_market_origin.get((market, hs6, y - 1), {})
        own = [by_origin_lookup.get((market, hs6, exporter, t), 0.0) for t in (y - 1, y + 1, y + 2)]
        safeguard = "ALL" in names  # a safeguard hit every origin: no rest of the market to compare with
        rest_flows = {} if safeguard else {o: v for o, v in before_flows.items() if o not in names}
        named_before = before_total - sum(rest_flows.values())
        features = (
            named_before / before_total if before_total > 0 else np.nan,  # named_share_of_market
            own[0] / named_before if named_before > 0 else np.nan,  # own_share_of_named
            max(rest_flows.values(), default=0.0) / before_total if before_total > 0 else np.nan,  # top_rest_share_of_market
            float(sum(v >= 0.01 * before_total for v in rest_flows.values())) if before_total > 0 else np.nan,  # rest_suppliers_over_1pct
        )
        if y + 2 > LAST_TRADE_YEAR:
            out.append((np.nan,) * 4 + features)
            continue
        if safeguard:
            out.append((own[0], max(own[1], own[2]), np.nan, np.nan) + features)
            continue
        rest = []
        for t in (y - 1, y + 1, y + 2):
            flows = per_market_origin.get((market, hs6, t), {})
            rest.append(total.get((market, hs6, t), 0.0) - sum(flows.get(n, 0.0) for n in names))
        out.append((own[0], max(own[1], own[2]), rest[0], max(rest[1], rest[2])) + features)
    return pd.DataFrame(out, columns=["own_before", "own_after", "rest_before", "rest_after", *MARKET_SHAPE_FEATURES], index=cases.index)


def imports_fell(changes: pd.DataFrame) -> pd.Series:
    """The named origin's imports fell to at most half of the year before."""
    fell = changes["own_after"] <= FALL_SHARE * changes["own_before"]
    return fell.astype(float).where(changes["own_before"].gt(0) & changes["own_after"].notna())


def imports_fell_vs_rest(changes: pd.DataFrame) -> pd.Series:
    """The named origin's imports fell to at most half of how the rest of the market moved: 'China
    -70% while the rest -5%' counts, 'China -60% while the rest -55%' does not. Where the rest of the
    market is under REST_MIN_USD the year before, there is nothing to compare with: the plain fall counts."""
    own_ratio = changes["own_after"] / changes["own_before"]
    rest_ratio = (changes["rest_after"] / changes["rest_before"]).where(changes["rest_before"] >= REST_MIN_USD)
    relative = (own_ratio <= FALL_SHARE * rest_ratio).astype(float).where(rest_ratio.notna())
    return relative.fillna(imports_fell(changes)).where(changes["own_before"].gt(0) & changes["own_after"].notna())


def with_features(cases: pd.DataFrame) -> pd.DataFrame:
    """Joins the trade risk features of the year before the opening (only flows of $1M+ have them). A
    safeguard (origin "ALL") gets a row for each of the market's SAFEGUARD_TOP_ORIGINS biggest suppliers."""
    features = pd.read_parquet(FEATURES_FILE, columns=["market", "exporter", "hs6", "year", *FEATURES])
    features["year"] = features["year"] + 1  # the year before the opening
    named = cases[cases["exporter"].ne("ALL")].merge(features, on=["market", "exporter", "hs6", "year"], how="inner")
    safeguards = cases[cases["exporter"].eq("ALL")].drop(columns="exporter")
    biggest = features.merge(safeguards[["market", "hs6", "year"]].drop_duplicates(), on=["market", "hs6", "year"])
    biggest = biggest.sort_values("import_value_usd", ascending=False).groupby(["market", "hs6", "year"]).head(SAFEGUARD_TOP_ORIGINS)
    safeguards = safeguards.merge(biggest, on=["market", "hs6", "year"], how="inner")
    safeguards["origins_in_investigation"] = safeguards.groupby("case_id")["exporter"].transform("nunique").astype("float32")
    return pd.concat([named, safeguards], ignore_index=True)


def build() -> None:
    cases = case_rows()
    print(f"cases: {cases['case_id'].nunique():,} cases, {len(cases):,} case x product rows, {FIRST_YEAR}-{LAST_YEAR}")
    cases = cases.merge(past_duty_rates(cases), on="case_id", how="left")
    rows = with_features(cases)
    print(f"with trade features (a flow of $1M+ the year before): {len(rows):,} rows, {rows['case_id'].nunique():,} cases")
    all_cases = pd.read_parquet(HARSHNESS_CASES_FILE, columns=["market", "exporter", "hs6", "year"])
    changes = import_changes(rows, market_imports(rows), all_cases)
    rows = pd.concat([rows, changes], axis=1)
    rows["imports_fell"] = imports_fell(changes)
    rows["imports_fell_vs_rest"] = imports_fell_vs_rest(changes)
    rows["both"] = rows["ended_in_duty"] * rows["imports_fell"]  # missing when either is
    rows["both_vs_rest"] = rows["ended_in_duty"] * rows["imports_fell_vs_rest"]
    rows = rows.merge(past_fall_rates(rows), on="case_id", how="left")
    rows = rows[rows[list(LABELS)].notna().any(axis=1)].reset_index(drop=True)
    keep = ["case_id", "investigation", "market", "exporter", "hs6", "year", "opened_on", "kind", "outcome", *LABELS, *CASE_FEATURES,
            *PAST_FALL_FEATURES, *FEATURES, *changes.columns]
    rows[keep].to_parquet(HARSHNESS_FILE, index=False)
    print(f"saved {len(rows):,} rows to {HARSHNESS_FILE}")
    print(rows.groupby("year")[list(LABELS)].agg(["mean", "count"]).round(3).to_string())
    print(rows.groupby("kind")[list(LABELS)].mean().round(3).to_string())


# ---------------------------------------------------------------- compare

def baseline_scores(frame: pd.DataFrame, label: str) -> dict[str, np.ndarray]:
    """Simple scores a model has to beat."""
    return {
        "market_duty_rate": frame["market_duty_rate_before"].fillna(frame["market_duty_rate_before"].mean()).to_numpy(),
        "origin_share_of_market": frame["exporter_share_of_market"].fillna(0).to_numpy(),
    }


def case_weights(frame: pd.DataFrame) -> np.ndarray:
    """1 / the case's row count: a case with 20 HS codes counts once, like a case with one."""
    return (1.0 / frame.groupby("case_id")["case_id"].transform("size")).to_numpy()


def ensemble(train: pd.DataFrame, label: str, features: list[str], weights: np.ndarray, params: dict | None = None) -> Ensemble:
    train = train.copy()
    train["weight"] = weights / weights.mean()
    train["case_opened_next_year"] = train[label]  # the training code's label column
    params = params or PARAMS
    return Ensemble([Model(kind, params[kind]) for kind in BOOSTED_TREES]).fit(train, features)


def per_case_metrics(score: np.ndarray, test: pd.DataFrame, label: str) -> dict:
    labels, weights = test[label].to_numpy(), case_weights(test)
    m = metrics(score, labels)
    return {
        "rows": m["rows"], "positives": m["cases"], "base_rate": float(labels.mean()),
        "auc": m["auc"], "average_precision": m["average_precision"],
        # Each case counted once: rows weighted by 1 / the case's row count.
        "auc_per_case": float(roc_auc_score(labels, score, sample_weight=weights)),
        "average_precision_per_case": float(average_precision_score(labels, score, sample_weight=weights)),
        "base_rate_per_case": float(np.average(labels, weights=weights)),
    }


# ---------------------------------------------------------------- tune

def harshness_params(kind: str, rng: np.random.Generator) -> dict:
    """Settings to try, sized for a few thousand rows."""
    def pick(values):
        return values[rng.integers(len(values))]
    if kind == "lightgbm":
        return {"num_leaves": int(pick([4, 7, 15, 31])), "learning_rate": float(pick([0.01, 0.02, 0.03, 0.05])),
                "n_estimators": int(pick([100, 200, 400, 800])), "min_child_samples": int(pick([20, 40, 80, 150, 300])),
                "reg_lambda": float(pick([0.0, 1.0, 5.0, 20.0])), "colsample_bytree": float(pick([0.3, 0.5, 0.7, 0.9])),
                "subsample": float(pick([0.5, 0.7, 0.9]))}
    if kind == "xgboost":
        return {"max_depth": int(pick([2, 3, 4, 5, 6])), "learning_rate": float(pick([0.01, 0.02, 0.03, 0.05])),
                "n_estimators": int(pick([100, 200, 400, 800])), "min_child_weight": float(pick([1, 5, 10, 20, 50])),
                "reg_lambda": float(pick([1.0, 5.0, 20.0])), "colsample_bytree": float(pick([0.3, 0.5, 0.7, 0.9])),
                "subsample": float(pick([0.5, 0.7, 0.9]))}
    if kind == "catboost":
        return {"depth": int(pick([3, 4, 5, 6])), "learning_rate": float(pick([0.02, 0.03, 0.05])),
                "iterations": int(pick([200, 400, 800])), "l2_leaf_reg": float(pick([1.0, 3.0, 10.0, 30.0])),
                "random_strength": float(pick([0.5, 1.0, 2.0]))}
    raise ValueError(kind)


def tune() -> None:
    """For each label in TUNE_LABELS and each model kind, tries the default and TUNE_TRIALS other settings
    and keeps the one with the best per-case AUC on TUNE_VALID_YEARS (trained on the years before each).
    Those years come before every test year, so the test stays untouched."""
    rows = pd.read_parquet(HARSHNESS_FILE)
    features = CASE_FEATURES + NEW_FEATURES + FEATURES
    tuned = {}
    for label in TUNE_LABELS:
        tuned[label] = {}
        splits = [(rows[(rows["year"] < y) & rows[label].notna()], rows[(rows["year"] == y) & rows[label].notna()]) for y in TUNE_VALID_YEARS]
        for kind in BOOSTED_TREES:
            rng = np.random.default_rng(0)
            trials = [PARAMS[kind]] + [harshness_params(kind, rng) for _ in range(TUNE_TRIALS)]
            results = []
            for params in trials:
                aucs = []
                for train, valid in splits:
                    frame = train.assign(weight=1.0, case_opened_next_year=train[label])
                    score = Model(kind, params).fit(frame, features).score(valid)
                    aucs.append(roc_auc_score(valid[label], score, sample_weight=case_weights(valid)))
                results.append((float(np.mean(aucs)), params))
            best = max(results, key=lambda r: r[0])
            tuned[label][kind] = {"valid_auc_per_case": best[0], "default_valid_auc_per_case": results[0][0], "params": best[1]}
            print(f"{label} {kind}: valid AUC per case {results[0][0]:.3f} default, {best[0]:.3f} best {best[1]}", flush=True)
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    TUNED_FILE.write_text(json.dumps(tuned, indent=1))
    print(f"saved {TUNED_FILE}")


# ---------------------------------------------------------------- compare

def feature_importance(rows: pd.DataFrame, label: str, features: list[str], params: dict) -> dict[str, float]:
    """LightGBM's gain per feature, as a share of the total, trained on every labelled row."""
    train = rows[rows[label].notna()]
    model = Model("lightgbm", params["lightgbm"]).fit(train.assign(weight=1.0, case_opened_next_year=train[label]), features)
    gain = model.estimator.booster_.feature_importance(importance_type="gain")
    shares = pd.Series(gain / gain.sum(), index=features).sort_values(ascending=False)
    return {name: round(float(v), 4) for name, v in shares.head(20).items()}


def compare() -> None:
    rows = pd.read_parquet(HARSHNESS_FILE)
    all_features = CASE_FEATURES + NEW_FEATURES + FEATURES
    second_try = [f for f in CASE_FEATURES if f != "market_chapter_duty_rate_before"] + FEATURES
    tuned = json.loads(TUNED_FILE.read_text()) if TUNED_FILE.exists() else {}
    results = {}
    for label in LABELS:
        tuned_params = {kind: v["params"] for kind, v in tuned[label].items()} if label in tuned else None
        per_model: dict[str, dict] = {}
        for year in TEST_YEARS.get(label, IMPORT_TEST_YEARS):
            train, test = rows[(rows["year"] < year) & rows[label].notna()], rows[(rows["year"] == year) & rows[label].notna()]
            if test[label].nunique() < 2:
                continue
            ones = np.ones(len(train))
            scores = baseline_scores(test, label)
            scores["ensemble_second_try_features"] = ensemble(train, label, second_try, ones).score(test)
            scores["ensemble_new_features"] = ensemble(train, label, all_features, ones).score(test)
            if tuned_params:
                scores["ensemble_new_features_tuned"] = ensemble(train, label, all_features, ones, tuned_params).score(test)
            for name, score in scores.items():
                per_model.setdefault(name, {})[year] = per_case_metrics(score, test, label)
        summary = {}
        for name, per_year in per_model.items():
            summary[name] = {key: float(np.mean([v[key] for v in per_year.values()]))
                             for key in ("auc", "average_precision", "base_rate", "auc_per_case", "average_precision_per_case", "base_rate_per_case")}
        importance = feature_importance(rows, label, all_features, tuned_params or PARAMS)
        results[label] = {"summary": summary, "per_year": {k: {str(y): v for y, v in d.items()} for k, d in per_model.items()},
                          "importance": importance}
        print(f"\n== label: {label}")
        print(pd.DataFrame(summary).T.round(3).to_string())
        print("top features (gain share):", list(importance.items())[:10])
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    (RUN_DIR / "compare.json").write_text(json.dumps(results, indent=1))
    print(f"\nsaved {RUN_DIR / 'compare.json'}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("step", choices=["build", "tune", "compare"])
    args = parser.parse_args()
    {"build": build, "tune": tune, "compare": compare}[args.step]()


if __name__ == "__main__":
    main()
