"""Compare models for the trade defence risk model, then train the chosen one.

    uv run python -m trade_risk.train tune      # random search per model, validated on 2016, 2017 and 2018
    uv run python -m trade_risk.train compare   # walk-forward test 2019-2023 for every model, plus ablations
    (then trade_risk.final_model trains the chosen one on every labelled year)

Walk-forward: for each test year Y, a model is trained on the rows of 2013 to Y-1 only (their labels
are cases opened up to Y) and scores the rows of Y; no test year is used for tuning. Training keeps
every case row and a random NEGATIVE_SHARE of the others, weighted back up, which keeps the scores'
scale and makes training ~10x faster. Metrics per test year: average precision (the main one: how
high the real cases are ranked), AUC, and the share of real cases in the top 1% and 5% of rows.
Results go to models/trade_risk/<date>/.
"""

import argparse
import json
import os
import time
from datetime import date

import lightgbm as lgb
import numpy as np
import pandas as pd
import xgboost as xgb
from catboost import CatBoostClassifier
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from trade_risk.common import FEATURES_FILE, INTERIM_DIR, MODELS_DIR
from trade_risk.features import BASELINE_FEATURES, FEATURES, HISTORY_FEATURES, LABEL, TRADE_FEATURES

NEGATIVE_SHARE = 0.1
# Tuning: each validation year scored by a model trained on the years before it (no test year used).
TUNE_VALID_YEARS = (2016, 2017, 2018)
TEST_YEARS = (2019, 2020, 2021, 2022, 2023)
THREADS = 16
SEED = 7
RUN_DIR = MODELS_DIR / os.environ.get("TRADE_RISK_RUN", date.today().isoformat())
TUNED_FILE = RUN_DIR / "tuned_params.json"
COMPARE_FILE = RUN_DIR / "compare.json"
PREDICTIONS_FILE = INTERIM_DIR / "walk_forward_predictions.parquet"
RATIO_FEATURES = [f for f in FEATURES if "_vs_" in f]
COUNT_FEATURES = ["import_value_usd", "market_import_value_usd", "exporter_rank_in_market", "market_supplier_count"] + [
    f for f in HISTORY_FEATURES if f not in ("years_since_last_case_same_market_exporter_product", "measure_in_force_same_market_exporter_product")
]
TUNING_BUDGET = {"lightgbm": 25, "lightgbm_rf": 10, "xgboost": 15, "catboost": 8, "random_forest": 5}
DUTY_FEATURES = ["market_duties_in_force_on_product_against_others", "market_duties_in_force_on_heading_against_others",
                 "import_growth_vs_market_growth"]
BOOSTED_TREES = ["lightgbm", "xgboost", "catboost"]


def load_panel() -> pd.DataFrame:
    panel = pd.read_parquet(FEATURES_FILE)
    return panel[panel["label_known"]].reset_index(drop=True)


def training_sample(panel: pd.DataFrame, years, seed: int) -> pd.DataFrame:
    rows = panel[panel["year"].isin(list(years))]
    rng = np.random.default_rng(seed)
    keep = (rows[LABEL] == 1) | (rng.random(len(rows)) < NEGATIVE_SHARE)
    sample = rows[keep].copy()
    sample["weight"] = np.where(sample[LABEL] == 1, 1.0, 1.0 / NEGATIVE_SHARE)
    return sample


# ---------------------------------------------------------------- inputs for the linear and neural models

def linear_inputs(frame: pd.DataFrame, features: list[str]) -> np.ndarray:
    columns = {}
    for name in features:
        values = frame[name].to_numpy(dtype="float64")
        if name == "hs_chapter":
            continue
        if name in RATIO_FEATURES:
            columns[name + "_missing"] = np.isnan(values).astype(float)
            values = np.log(np.clip(np.nan_to_num(values, nan=1.0), 1e-3, 1e3))
        elif name in COUNT_FEATURES:
            values = np.log1p(np.clip(np.nan_to_num(values), 0, None))
        elif name == "years_since_last_case_same_market_exporter_product":
            columns[name + "_missing"] = np.isnan(values).astype(float)
            values = np.nan_to_num(values, nan=40.0)
        else:
            columns[name + "_missing"] = np.isnan(values).astype(float)
            values = np.clip(np.nan_to_num(values), -5, 5)
        columns[name] = values
    if "hs_chapter" in features:
        chapters = frame["hs_chapter"].to_numpy()
        for chapter in range(1, 98):
            columns[f"chapter_{chapter}"] = (chapters == chapter).astype(float)
    return np.column_stack(list(columns.values()))


# ---------------------------------------------------------------- models

class Rule:
    """A hand-written score, for reference: no training."""

    def __init__(self, name: str):
        self.name = name

    def fit(self, frame, features):
        return self

    def score(self, frame):
        if self.name == "rule_share_growth":
            return frame["exporter_share_change_1y"].fillna(0).to_numpy()
        # "This market or others are already casing this product": counts first, size breaks ties.
        return (3 * frame["other_exporters_cased_on_product_last_2y"] + frame["market_cases_on_heading_last_2y"]
                + 0.5 * frame["cases_on_product_all_markets_last_2y"]
                + 0.1 * np.log10(frame["import_value_usd"].clip(lower=1))).to_numpy()


class Model:
    def __init__(self, kind: str, params: dict | None = None):
        self.kind, self.params, self.estimator, self.features = kind, dict(params or {}), None, None

    def fit(self, frame: pd.DataFrame, features: list[str]):
        self.features = features
        y, w = frame[LABEL].to_numpy(), frame["weight"].to_numpy()
        if self.kind == "lightgbm":
            self.estimator = lgb.LGBMClassifier(**{"subsample_freq": 1, "verbose": -1, "n_jobs": THREADS, "random_state": SEED, **self.params})
            self.estimator.fit(frame[features], y, sample_weight=w)
        elif self.kind == "lightgbm_rf":  # LightGBM's random forest mode: a forest that explains itself (SHAP)
            self.estimator = lgb.LGBMClassifier(**{"boosting_type": "rf", "subsample_freq": 1, "verbose": -1,
                                                   "n_jobs": THREADS, "random_state": SEED, **self.params})
            self.estimator.fit(frame[features], y, sample_weight=w)
        elif self.kind == "xgboost":
            self.estimator = xgb.XGBClassifier(**{"tree_method": "hist", "n_jobs": THREADS, "random_state": SEED, **self.params})
            self.estimator.fit(frame[features], y, sample_weight=w)
        elif self.kind == "catboost":
            categorical = ["hs_chapter"] if "hs_chapter" in features else []
            self.estimator = CatBoostClassifier(**{"verbose": 0, "thread_count": THREADS, "random_seed": SEED,
                                                   "allow_writing_files": False, **self.params})
            self.estimator.fit(frame[features], y, sample_weight=w, cat_features=categorical)
        elif self.kind == "random_forest":
            self.estimator = RandomForestClassifier(**{"n_estimators": 300, "min_samples_leaf": 30, "max_features": "sqrt",
                                                       "n_jobs": THREADS, "random_state": SEED, **self.params})
            self.estimator.fit(frame[features], y, sample_weight=w)
        elif self.kind == "logistic_regression":
            self.estimator = make_pipeline(StandardScaler(), LogisticRegression(**{"C": 0.1, "max_iter": 3000, **self.params}))
            self.estimator.fit(linear_inputs(frame, features), y, logisticregression__sample_weight=w)
        elif self.kind == "neural_network":
            self.estimator = make_pipeline(StandardScaler(), MLPClassifier(**{
                "hidden_layer_sizes": (64, 32), "alpha": 1e-3, "early_stopping": True, "max_iter": 60,
                "random_state": SEED, **self.params}))
            self.estimator.fit(linear_inputs(frame, features), y)  # MLP: the sample alone, unweighted
        else:
            raise ValueError(self.kind)
        return self

    def score(self, frame: pd.DataFrame) -> np.ndarray:
        if self.kind in ("logistic_regression", "neural_network"):
            return self.estimator.predict_proba(linear_inputs(frame, self.features))[:, 1]
        return self.estimator.predict_proba(frame[self.features])[:, 1]


def log_odds(probability: np.ndarray) -> np.ndarray:
    probability = np.clip(probability, 1e-9, 1 - 1e-9)
    return np.log(probability / (1 - probability))


def log_odds_average(*scores: np.ndarray) -> np.ndarray:
    """The probability whose log-odds is the average of the models' log-odds."""
    return 1 / (1 + np.exp(-np.mean([log_odds(s) for s in scores], axis=0)))


def rank_average(*scores: np.ndarray) -> np.ndarray:
    """The average of each model's percentile among the rows scored together."""
    return np.mean([pd.Series(s).rank(pct=True).to_numpy() for s in scores], axis=0)


class Ensemble:
    """Models trained on the same rows whose log-odds are averaged. Each boosted model estimates the
    probability of a case, so the average is one too, and its explanation (SHAP) is exactly the
    average of theirs."""

    kind = "ensemble"

    def __init__(self, members: list[Model]):
        self.members, self.features = members, None

    def fit(self, frame: pd.DataFrame, features: list[str]):
        self.features = features
        for member in self.members:
            member.fit(frame, features)
        return self

    def score(self, frame: pd.DataFrame) -> np.ndarray:
        return log_odds_average(*(member.score(frame) for member in self.members))


# Compared from the members' walk-forward scores. Forests' scores aren't probabilities, so a mix with
# them averages ranks, which needs every row of a year at once (fine for a test, not for one order).
ENSEMBLES = {
    "ensemble_boosted_trees": (BOOSTED_TREES, log_odds_average),
    "ensemble_forest_and_boosted": (["random_forest", "lightgbm_rf", *BOOSTED_TREES], rank_average),
}


# ---------------------------------------------------------------- metrics

def share_found_in_top(scores: np.ndarray, labels: np.ndarray, share: float) -> float:
    top = np.argsort(-scores, kind="stable")[: max(1, int(len(scores) * share))]
    return float(labels[top].sum() / max(labels.sum(), 1))


def metrics(scores: np.ndarray, labels: np.ndarray) -> dict:
    return {
        "rows": int(len(labels)), "cases": int(labels.sum()),
        "average_precision": float(average_precision_score(labels, scores)),
        "auc": float(roc_auc_score(labels, scores)),
        "found_in_top_1pct": share_found_in_top(scores, labels, 0.01),
        "found_in_top_5pct": share_found_in_top(scores, labels, 0.05),
    }


def summarise(per_year: dict[int, dict]) -> dict:
    keys = ["average_precision", "auc", "found_in_top_1pct", "found_in_top_5pct"]
    summary = {k: float(np.mean([m[k] for m in per_year.values()])) for k in keys}
    summary["cases"] = int(sum(m["cases"] for m in per_year.values()))
    return summary


# ---------------------------------------------------------------- tuning

def random_params(kind: str, rng: np.random.Generator) -> dict:
    pick = lambda values: values[rng.integers(len(values))]
    if kind == "lightgbm":
        return {"num_leaves": int(pick([7, 15, 31, 63, 127])), "learning_rate": float(pick([0.01, 0.02, 0.05, 0.1])),
                "n_estimators": int(pick([200, 400, 800, 1500])), "min_child_samples": int(pick([20, 50, 100, 200, 500])),
                "reg_lambda": float(pick([0.0, 1.0, 5.0, 20.0, 50.0])), "colsample_bytree": float(pick([0.5, 0.7, 0.9, 1.0])),
                "subsample": float(pick([0.5, 0.7, 0.9])), "min_split_gain": float(pick([0.0, 0.01, 0.1]))}
    if kind == "xgboost":
        return {"max_depth": int(pick([3, 4, 5, 6, 8])), "learning_rate": float(pick([0.01, 0.02, 0.05, 0.1])),
                "n_estimators": int(pick([200, 400, 800, 1500])), "min_child_weight": float(pick([1, 5, 20, 50, 100])),
                "reg_lambda": float(pick([1.0, 5.0, 20.0, 50.0])), "colsample_bytree": float(pick([0.5, 0.7, 0.9, 1.0])),
                "subsample": float(pick([0.5, 0.7, 0.9])), "gamma": float(pick([0.0, 0.1, 1.0]))}
    if kind == "catboost":
        return {"depth": int(pick([4, 6, 8])), "learning_rate": float(pick([0.03, 0.05, 0.1])),
                "iterations": int(pick([500, 1000, 2000])), "l2_leaf_reg": float(pick([1.0, 3.0, 10.0, 30.0])),
                "random_strength": float(pick([0.5, 1.0, 2.0])), "bagging_temperature": float(pick([0.0, 0.5, 1.0]))}
    if kind == "lightgbm_rf":
        return {"num_leaves": int(pick([63, 255, 1023, 4095])), "n_estimators": int(pick([300, 600])),
                "min_child_samples": int(pick([10, 30, 100, 300])), "colsample_bytree": float(pick([0.2, 0.3, 0.5, 0.7])),
                "subsample": float(pick([0.3, 0.5, 0.632, 0.8]))}
    if kind == "random_forest":
        return {"min_samples_leaf": int(pick([5, 10, 30, 100])), "max_features": pick(["sqrt", 0.3, 0.5]),
                "max_depth": pick([None, 12, 20])}
    if kind == "logistic_regression":
        return {"C": float(pick([0.003, 0.01, 0.03, 0.1, 1.0]))}
    raise ValueError(kind)


def tuning_score(kind: str, params: dict, samples: dict, valid: dict) -> dict:
    per_year = {}
    for year in TUNE_VALID_YEARS:
        model = Model(kind, params).fit(samples[year], FEATURES)
        per_year[year] = metrics(model.score(valid[year]), valid[year][LABEL].to_numpy())
    return summarise(per_year)


def tune(panel: pd.DataFrame, kinds: list[str] | None) -> None:
    samples = {year: training_sample(panel, range(2013, year), SEED + year) for year in TUNE_VALID_YEARS}
    valid = {year: panel[panel["year"] == year] for year in TUNE_VALID_YEARS}
    rng = np.random.default_rng(SEED)
    tuned = json.loads(TUNED_FILE.read_text()) if TUNED_FILE.exists() else {}
    budgets = {**TUNING_BUDGET, "logistic_regression": 5}
    for kind, budget in budgets.items():
        if kinds and kind not in kinds:
            continue
        trials, seen = [], set()
        # The previous best is scored again first, so a new search only replaces it by doing better.
        previous = [tuned[kind]["best"]["params"]] if kind in tuned else []
        while len(trials) < budget:
            params = previous.pop() if previous else random_params(kind, rng)
            if json.dumps(params, sort_keys=True) in seen:
                continue
            seen.add(json.dumps(params, sort_keys=True))
            started = time.time()
            result = tuning_score(kind, params, samples, valid)
            trials.append({"params": params, **result, "seconds": round(time.time() - started)})
            print(f"{kind} {len(trials)}/{budget}: AP {result['average_precision']:.4f}, top 5% {result['found_in_top_5pct']:.3f}"
                  f" ({trials[-1]['seconds']}s) {params}", flush=True)
        best = max(trials, key=lambda t: t["average_precision"])
        tuned[kind] = {"best": best, "trials": trials, "valid_years": list(TUNE_VALID_YEARS)}
        RUN_DIR.mkdir(parents=True, exist_ok=True)
        TUNED_FILE.write_text(json.dumps(tuned, indent=1))
        print(f"== {kind} best: AP {best['average_precision']:.4f} {best['params']}", flush=True)


# ---------------------------------------------------------------- walk-forward comparison

def candidates(tuned: dict) -> dict:
    best = lambda kind: tuned.get(kind, {}).get("best", {}).get("params", {})
    return {
        "rule_share_growth": (lambda: Rule("rule_share_growth"), FEATURES),
        "rule_case_history": (lambda: Rule("rule_case_history"), FEATURES),
        "logistic_regression": (lambda: Model("logistic_regression", best("logistic_regression")), FEATURES),
        "random_forest": (lambda: Model("random_forest", best("random_forest")), FEATURES),
        "lightgbm_rf": (lambda: Model("lightgbm_rf", best("lightgbm_rf")), FEATURES),
        "neural_network": (lambda: Model("neural_network"), FEATURES),
        "lightgbm": (lambda: Model("lightgbm", best("lightgbm")), FEATURES),
        "xgboost": (lambda: Model("xgboost", best("xgboost")), FEATURES),
        "catboost": (lambda: Model("catboost", best("catboost")), FEATURES),
        # Ablations, on the tuned LightGBM.
        "lightgbm_baseline_features": (lambda: Model("lightgbm", best("lightgbm")), BASELINE_FEATURES),
        "lightgbm_without_duty_features": (lambda: Model("lightgbm", best("lightgbm")), [f for f in FEATURES if f not in DUTY_FEATURES]),
        "lightgbm_trade_only": (lambda: Model("lightgbm", best("lightgbm")), TRADE_FEATURES),
        "lightgbm_history_only": (lambda: Model("lightgbm", best("lightgbm")), HISTORY_FEATURES),
    }


def compare(panel: pd.DataFrame, only: list[str] | None) -> None:
    tuned = json.loads(TUNED_FILE.read_text()) if TUNED_FILE.exists() else {}
    results = json.loads(COMPARE_FILE.read_text()) if COMPARE_FILE.exists() else {}
    predictions = pd.read_parquet(PREDICTIONS_FILE) if PREDICTIONS_FILE.exists() else None
    keep_columns = ["market", "exporter", "hs6", "year", LABEL]
    test_frames = {year: panel[panel["year"] == year] for year in TEST_YEARS}
    if predictions is None:
        predictions = pd.concat([test_frames[y][keep_columns] for y in TEST_YEARS], ignore_index=True)
    for name, (make, features) in candidates(tuned).items():
        if only and name not in only:
            continue
        per_year, scores_all, started = {}, [], time.time()
        for year in TEST_YEARS:
            train = training_sample(panel, range(2013, year), SEED + year)
            model = make().fit(train, features)
            scores = model.score(test_frames[year])
            per_year[year] = metrics(scores, test_frames[year][LABEL].to_numpy())
            scores_all.append(scores)
        predictions[name] = np.concatenate(scores_all)
        results[name] = {"summary": summarise(per_year), "per_year": per_year, "seconds": round(time.time() - started)}
        s = results[name]["summary"]
        print(f"{name}: AP {s['average_precision']:.4f}, AUC {s['auc']:.3f}, top 1% {s['found_in_top_1pct']:.3f}, "
              f"top 5% {s['found_in_top_5pct']:.3f} ({results[name]['seconds']}s)", flush=True)
        RUN_DIR.mkdir(parents=True, exist_ok=True)
        COMPARE_FILE.write_text(json.dumps(results, indent=1))
        predictions.to_parquet(PREDICTIONS_FILE, index=False)
    for name, (members, combine) in ENSEMBLES.items():
        if not all(m in predictions for m in members):
            continue
        per_year, ensemble = {}, np.zeros(len(predictions))
        for year in TEST_YEARS:
            mask = (predictions["year"] == year).to_numpy()
            ensemble[mask] = combine(*(predictions.loc[mask, m].to_numpy() for m in members))
            per_year[year] = metrics(ensemble[mask], predictions.loc[mask, LABEL].to_numpy())
        predictions[name] = ensemble
        results[name] = {"summary": summarise(per_year), "per_year": per_year, "members": members,
                         "combined_by": combine.__name__}
        s = results[name]["summary"]
        print(f"{name}: AP {s['average_precision']:.4f}, AUC {s['auc']:.3f}, top 1% {s['found_in_top_1pct']:.3f}, "
              f"top 5% {s['found_in_top_5pct']:.3f}", flush=True)
    COMPARE_FILE.write_text(json.dumps(results, indent=1))
    predictions.to_parquet(PREDICTIONS_FILE, index=False)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("stage", choices=["tune", "compare"])
    parser.add_argument("--only", nargs="*", help="run only these models")
    args = parser.parse_args()
    panel = load_panel()
    print(f"{len(panel):,} labelled rows, {int(panel[LABEL].sum()):,} with a case the next year", flush=True)
    if args.stage == "tune":
        tune(panel, args.only)
    else:
        compare(panel, args.only)


if __name__ == "__main__":
    main()
