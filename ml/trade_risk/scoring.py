"""The chosen model as saved by `final_model`: score rows, explain them, give each a risk level.

A model version is a folder `models/trade_risk/<date>/` with the three boosted models
(LightGBM, XGBoost, CatBoost), `features.json`, and `report.json` with the score cut-offs of the
top 1% and top 5% of the latest year's rows (`thresholds_2024`). The score is the probability
whose log-odds is the average of the three models' log-odds; its explanation (SHAP) is the average
of theirs, exactly, since SHAP values add up.
"""

import json
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
import xgboost as xgb
from catboost import CatBoostClassifier, Pool

from trade_risk.common import MODELS_DIR
from trade_risk.train import log_odds_average

QUANTILES_FILE = "score_quantiles.json"  # 1,001 quantiles of the latest year's scores, for the percentile


def latest_version_dir() -> Path:
    """The newest model folder that holds a saved model."""
    folders = sorted(p for p in MODELS_DIR.iterdir() if (p / "report.json").exists() and (p / "features.json").exists())
    if not folders:
        raise FileNotFoundError(f"no saved model in {MODELS_DIR}; run `python -m trade_risk.final_model` first")
    return folders[-1]


class SavedModel:
    def __init__(self, folder: Path):
        self.folder = folder
        self.version = folder.name
        self.features: list[str] = json.loads((folder / "features.json").read_text())
        report = json.loads((folder / "report.json").read_text())
        self.thresholds: dict[str, float] = report["thresholds_2024"]
        self.lightgbm = lgb.Booster(model_file=str(folder / "model_lightgbm.txt"))
        self.xgboost = xgb.Booster()
        self.xgboost.load_model(str(folder / "model_xgboost.json"))
        self.catboost = CatBoostClassifier()
        self.catboost.load_model(str(folder / "model_catboost.cbm"))
        quantiles = folder / QUANTILES_FILE
        self.quantiles = np.array(json.loads(quantiles.read_text())) if quantiles.exists() else None

    def inputs(self, rows: pd.DataFrame) -> pd.DataFrame:
        frame = rows[self.features].astype("float32")
        frame["hs_chapter"] = rows["hs_chapter"].astype("int16")
        return frame

    def _pool(self, frame: pd.DataFrame) -> Pool:
        return Pool(frame, cat_features=["hs_chapter"])

    def score(self, rows: pd.DataFrame) -> np.ndarray:
        frame = self.inputs(rows)
        return log_odds_average(
            self.lightgbm.predict(frame),
            self.xgboost.predict(xgb.DMatrix(frame)),
            self.catboost.predict_proba(self._pool(frame))[:, 1],
        )

    def contributions(self, rows: pd.DataFrame) -> np.ndarray:
        """Each feature's push on each row's score (log-odds), averaged over the three models."""
        frame = self.inputs(rows)
        return np.mean([
            self.lightgbm.predict(frame, pred_contrib=True)[:, :-1],
            self.xgboost.predict(xgb.DMatrix(frame), pred_contribs=True)[:, :-1],
            self.catboost.get_feature_importance(self._pool(frame), type="ShapValues")[:, :-1],
        ], axis=0)

    def level(self, scores: np.ndarray) -> np.ndarray:
        return np.where(scores >= self.thresholds["high"], "high",
                        np.where(scores >= self.thresholds["medium"], "medium", "low"))

    def percentile(self, scores: np.ndarray) -> np.ndarray | None:
        """The share of the latest year's rows that scored lower, or None without the quantiles."""
        if self.quantiles is None:
            return None
        return np.searchsorted(self.quantiles, scores, side="right") / len(self.quantiles)


def save_quantiles(folder: Path, scores: np.ndarray) -> None:
    quantiles = np.quantile(scores, np.linspace(0, 1, 1001))
    (folder / QUANTILES_FILE).write_text(json.dumps([float(q) for q in quantiles]))
