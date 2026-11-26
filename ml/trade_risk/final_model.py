"""Check the chosen model, train it on every labelled year, and score the latest year.

    uv run python -m trade_risk.final_model   # after `train tune` and `train compare`; --model picks another

Checks, from the walk-forward predictions of `train compare` (test years 2019-2023):
- by market, and for big markets left out of training entirely;
- exports from Vietnam;
- risk levels (top 1% of a year's rows = high, next 4% = medium): how often a case followed.
Then the model is trained on 2013-2023 and scores the 2024 rows (a case in 2025); the US rows are
checked against the real 2025 US cases (Federal Register).
Writes models/trade_risk/<date>/ (model, report.json) and data/interim/trade_risk/scores_2024.parquet.
"""

import argparse
import json

import numpy as np
import pandas as pd
import xgboost as xgb
from catboost import Pool
from sklearn.metrics import average_precision_score, roc_auc_score

from trade_risk.common import CASES_FILE, FEATURES_FILE, INTERIM_DIR
from trade_risk.explain import reasons, similar_cases
from trade_risk.features import FEATURES, LABEL
from trade_risk.scoring import save_quantiles
from trade_risk.train import (
    COMPARE_FILE,
    ENSEMBLES,
    PREDICTIONS_FILE,
    RUN_DIR,
    SEED,
    TEST_YEARS,
    TUNED_FILE,
    Ensemble,
    Model,
    metrics,
    share_found_in_top,
    training_sample,
)

# Models that score one row on its own and explain it (SHAP).
EXPLAINABLE = ["ensemble_boosted_trees", "lightgbm", "lightgbm_rf", "xgboost", "catboost"]
HELD_OUT_MARKETS = ("USA", "IND", "EU", "BRA", "TUR", "AUS", "CAN")
LEVEL_SHARES = {"high": 0.01, "medium": 0.05}  # top 1% of a year's rows, then the next 4%
SCORES_FILE = INTERIM_DIR / "scores_2024.parquet"
LATEST_YEAR = 2024


def percentile_in_year(scores: np.ndarray, years: np.ndarray) -> np.ndarray:
    frame = pd.DataFrame({"score": scores, "year": years})
    return frame.groupby("year")["score"].rank(pct=True, ascending=True).to_numpy()


def level_of(percentile: np.ndarray) -> np.ndarray:
    return np.where(percentile > 1 - LEVEL_SHARES["high"], "high",
                    np.where(percentile > 1 - LEVEL_SHARES["medium"], "medium", "low"))


def make_model(name: str, tuned: dict) -> Model | Ensemble:
    if name in ENSEMBLES:
        return Ensemble([Model(kind, tuned[kind]["best"]["params"]) for kind in ENSEMBLES[name][0]])
    return Model(name, tuned[name]["best"]["params"])


def contributions(model: Model | Ensemble, rows: pd.DataFrame) -> np.ndarray:
    """SHAP contribution of each feature to each row's score (log-odds), without the bias column."""
    if model.kind == "ensemble":
        return np.mean([contributions(member, rows) for member in model.members], axis=0)
    inputs = rows[model.features]
    if model.kind in ("lightgbm", "lightgbm_rf"):
        return model.estimator.booster_.predict(inputs, pred_contrib=True)[:, :-1]
    if model.kind == "xgboost":
        return model.estimator.get_booster().predict(xgb.DMatrix(inputs), pred_contribs=True)[:, :-1]
    if model.kind == "catboost":
        pool = Pool(inputs, cat_features=["hs_chapter"] if "hs_chapter" in model.features else [])
        return model.estimator.get_feature_importance(pool, type="ShapValues")[:, :-1]
    raise ValueError(f"no contributions for {model.kind}")


def by_market(predictions: pd.DataFrame, column: str) -> dict:
    result = {}
    for market, rows in predictions.groupby("market"):
        if rows[LABEL].sum() < 20:
            continue
        found = np.mean([share_found_in_top(r[column].to_numpy(), r[LABEL].to_numpy(), 0.05)
                         for _, r in rows.groupby("year") if r[LABEL].sum() > 0])
        result[market] = {"cases": int(rows[LABEL].sum()), "auc": float(roc_auc_score(rows[LABEL], rows[column])),
                          "average_precision": float(average_precision_score(rows[LABEL], rows[column])),
                          "found_in_market_top_5pct": float(found)}
    return result


def held_out_markets(panel: pd.DataFrame, make) -> dict:
    """Train on 2013-2020 without a market, test on that market's 2021-2023 rows."""
    test = panel[panel["year"].between(2021, 2023)]
    everyone = make().fit(training_sample(panel, range(2013, 2021), SEED), FEATURES)
    result = {}
    for market in HELD_OUT_MARKETS:
        rows = test[test["market"] == market]
        if rows[LABEL].sum() < 10:
            continue
        without = make().fit(training_sample(panel[panel["market"] != market], range(2013, 2021), SEED), FEATURES)
        result[market] = {
            "cases": int(rows[LABEL].sum()),
            "auc_trained_with_it": float(roc_auc_score(rows[LABEL], everyone.score(rows))),
            "auc_never_seen": float(roc_auc_score(rows[LABEL], without.score(rows))),
            "average_precision_trained_with_it": float(average_precision_score(rows[LABEL], everyone.score(rows))),
            "average_precision_never_seen": float(average_precision_score(rows[LABEL], without.score(rows))),
        }
        print(f"  {market}: AUC {result[market]['auc_trained_with_it']:.3f} trained with it, "
              f"{result[market]['auc_never_seen']:.3f} never seen", flush=True)
    return result


def risk_levels(predictions: pd.DataFrame, column: str) -> dict:
    percentile = percentile_in_year(predictions[column].to_numpy(), predictions["year"].to_numpy())
    levels = level_of(percentile)
    base = predictions[LABEL].mean()
    result = {}
    for level in ("high", "medium", "low"):
        rows = predictions[levels == level]
        result[level] = {"rows": int(len(rows)), "cases": int(rows[LABEL].sum()), "case_rate": float(rows[LABEL].mean()),
                         "times_the_average": float(rows[LABEL].mean() / base)}
    result["average_case_rate"] = float(base)
    return result


def vietnam(predictions: pd.DataFrame, column: str) -> dict:
    percentile = percentile_in_year(predictions[column].to_numpy(), predictions["year"].to_numpy())
    rows = predictions.assign(percentile=percentile)
    rows = rows[rows["exporter"] == "VNM"]
    cases = rows[rows[LABEL] == 1].sort_values("percentile", ascending=False)
    return {
        "rows": int(len(rows)), "cases": int(rows[LABEL].sum()),
        "auc": float(roc_auc_score(rows[LABEL], rows[column])),
        "cases_in_top_5pct_of_all_rows": int((cases["percentile"] > 0.95).sum()),
        "case_rows": cases[["year", "market", "hs6", "percentile"]].round(4).to_dict("records"),
    }


def cases_flagged(scored: pd.DataFrame, cases: pd.DataFrame, years) -> dict:
    """Case level: a case opened in year Y+1 is flagged when its best row of year Y is in the top
    1% (or 5%) of that year's rows. `scored` has market, exporter, hs6, year, percentile."""
    result = {}
    for share in (0.01, 0.05):
        found = total = 0
        for year in years:
            opened = cases[cases["year"] == year + 1]
            rows = opened.merge(scored[scored["year"] == year], on=["market", "exporter", "hs6"])
            best = rows.groupby(["case_id", "market", "exporter"])["percentile"].max()
            found += int((best > 1 - share).sum())
            total += len(best)
        result[f"in_top_{int(share * 100)}pct"] = found
        result["cases_with_a_row"] = total
    return result


def check_2025(latest: pd.DataFrame, cases: pd.DataFrame) -> dict:
    """The 2024 US rows (figures of 2024) against the US cases opened in 2025. Percentiles are among
    all markets' 2024 rows, as in the app."""
    rows = latest[latest["market"] == "USA"]
    result = metrics(rows["score"].to_numpy(), rows[LABEL].to_numpy())
    result["case_level"] = cases_flagged(latest[latest["market"] == "USA"], cases[cases["market"] == "USA"], [LATEST_YEAR])
    opened = cases[(cases["market"] == "USA") & (cases["year"] == LATEST_YEAR + 1)]
    ranked = opened.merge(rows, on=["market", "exporter", "hs6"])
    best = (ranked.sort_values("percentile", ascending=False)
            .groupby(["product", "exporter"], as_index=False).first()
            .sort_values("percentile", ascending=False))
    result["case_list"] = best[["product", "exporter", "hs6", "percentile", "level"]].round(4).to_dict("records")
    no_row = opened.groupby(["product", "exporter"]).size().index.difference(best.set_index(["product", "exporter"]).index)
    result["cases_without_a_flow_of_1m"] = [f"{p} ({e})" for p, e in no_row]
    return result


def save_model(model: Model | Ensemble) -> list[str]:
    """Write the model's file(s) to RUN_DIR: one per member of an ensemble."""
    files = []
    for member in model.members if model.kind == "ensemble" else [model]:
        if member.kind in ("lightgbm", "lightgbm_rf"):
            files.append(f"model_{member.kind}.txt")
            member.estimator.booster_.save_model(str(RUN_DIR / files[-1]))
        elif member.kind == "xgboost":
            files.append("model_xgboost.json")
            member.estimator.save_model(str(RUN_DIR / files[-1]))
        else:
            files.append("model_catboost.cbm")
            member.estimator.save_model(str(RUN_DIR / files[-1]))
    return files


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", default="ensemble_boosted_trees", choices=EXPLAINABLE)
    args = parser.parse_args()
    tuned = json.loads(TUNED_FILE.read_text())
    make = lambda: make_model(args.model, tuned)
    params = {kind: tuned[kind]["best"]["params"] for kind in (ENSEMBLES[args.model][0] if args.model in ENSEMBLES else [args.model])}
    compare = json.loads(COMPARE_FILE.read_text())
    predictions = pd.read_parquet(PREDICTIONS_FILE)
    panel_all = pd.read_parquet(FEATURES_FILE)
    panel = panel_all[panel_all["label_known"]].reset_index(drop=True)
    cases = pd.read_parquet(CASES_FILE)

    report = {"model": args.model, "params": params, "compare": {k: v["summary"] for k, v in compare.items()}}
    print("by market (walk-forward 2019-2023):", flush=True)
    report["by_market"] = by_market(predictions, args.model)
    for market, m in sorted(report["by_market"].items(), key=lambda kv: -kv[1]["cases"]):
        print(f"  {market}: {m['cases']} cases, AUC {m['auc']:.3f}, AP {m['average_precision']:.3f}, "
              f"top 5% of its rows finds {m['found_in_market_top_5pct']:.0%}")
    print("markets left out of training (train 2013-2020, test 2021-2023):", flush=True)
    report["held_out_markets"] = held_out_markets(panel, make)
    report["risk_levels"] = risk_levels(predictions, args.model)
    print("risk levels:", json.dumps(report["risk_levels"], indent=1))
    report["vietnam"] = vietnam(predictions, args.model)
    print(f"Vietnam: {report['vietnam']['cases']} cases, AUC {report['vietnam']['auc']:.3f}, "
          f"{report['vietnam']['cases_in_top_5pct_of_all_rows']} in the top 5% of all rows")
    walk_forward = predictions.assign(percentile=percentile_in_year(predictions[args.model].to_numpy(), predictions["year"].to_numpy()))
    report["cases_flagged_walk_forward"] = cases_flagged(walk_forward, cases, TEST_YEARS)
    print("cases opened 2020-2024, flagged a year ahead:", report["cases_flagged_walk_forward"])

    model = make().fit(training_sample(panel, range(2013, LATEST_YEAR), SEED), FEATURES)
    latest = panel_all[panel_all["year"] == LATEST_YEAR].copy()
    latest["score"] = model.score(latest)
    latest["percentile"] = latest["score"].rank(pct=True)
    latest["level"] = level_of(latest["percentile"].to_numpy())
    report["check_2025_us"] = check_2025(latest, cases)
    c = report["check_2025_us"]
    print(f"2025 US check: {c['cases']} case rows, cases {c['case_level']}; row level AUC {c['auc']:.3f}, AP {c['average_precision']:.3f}, "
          f"top 1% {c['found_in_top_1pct']:.0%}, top 5% {c['found_in_top_5pct']:.0%}")
    for case in c["case_list"]:
        print(f"  {case['product'][:50]:50} {case['exporter']} {case['hs6']} {case['level']:6} top {1 - case['percentile']:.2%}")
    print("  without a $1M flow in 2024:", c["cases_without_a_flow_of_1m"])

    sample = latest.sample(min(len(latest), 50_000), random_state=SEED)
    importance = pd.Series(np.abs(contributions(model, sample)).mean(axis=0), index=FEATURES).sort_values(ascending=False)
    report["feature_importance"] = (importance / importance.sum()).round(4).to_dict()
    print("features by mean |SHAP| (share):", {k: round(v, 3) for k, v in list(report["feature_importance"].items())[:12]})

    flagged = latest[latest["level"] != "low"].copy()
    flagged["reasons"] = reasons(flagged, contributions(model, flagged), FEATURES)
    latest = latest.merge(flagged[["market", "exporter", "hs6", "reasons"]], on=["market", "exporter", "hs6"], how="left")
    latest[["market", "exporter", "hs6", "year", "score", "percentile", "level", "reasons", LABEL, "label_known"]].to_parquet(SCORES_FILE, index=False)
    report["thresholds_2024"] = {level: float(latest["score"].quantile(1 - share)) for level, share in LEVEL_SHARES.items()}

    top_vietnam = latest[latest["exporter"] == "VNM"].nlargest(12, "score")
    print("\nVietnam's highest risks (figures of 2024, a case in 2025):")
    for _, row in top_vietnam.iterrows():
        similar = similar_cases(cases, row["market"], "VNM", row["hs6"], LATEST_YEAR, limit=1)
        print(f"  {row['market']} {row['hs6']} {row['level']} (top {1 - row['percentile']:.2%}) case in 2025: "
              f"{'yes' if row[LABEL] else ('no' if row['label_known'] else 'unknown')} | {'; '.join(row['reasons'] or [])}"
              f" | similar: {similar[['market', 'exporter', 'year', 'product', 'outcome']].to_dict('records')}")
    report["top_vietnam_2024"] = top_vietnam[["market", "hs6", "score", "percentile", "level", "reasons", LABEL]].to_dict("records")

    RUN_DIR.mkdir(parents=True, exist_ok=True)
    report["model_files"] = save_model(model)
    save_quantiles(RUN_DIR, latest["score"].to_numpy())
    (RUN_DIR / "features.json").write_text(json.dumps(FEATURES, indent=1))
    (RUN_DIR / "report.json").write_text(json.dumps(report, indent=1, default=str))
    print(f"wrote {RUN_DIR} and {SCORES_FILE}")


if __name__ == "__main__":
    main()
