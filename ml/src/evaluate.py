"""Score every candidate against Gemini on the rated articles → models/<date>/report.md + metrics.json.

    uv run python src/evaluate.py

There are too few rated articles (137) for a fixed test set, so this is 5-fold cross-validation over
articles: each article is predicted once by models that never saw it (articles with the same headline
stay in one fold). Rated GTA measures are always in training (or only they are, for "GTA only").
Gemini's own severity of the same articles (from the scan's alerts) is the baseline. First metric:
recall of `high`; then macro-F1; then how many it decides at confidence ≥ 0.6.
"""

import json
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier
from sklearn.decomposition import PCA
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import confusion_matrix, f1_score
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

ML = Path(__file__).resolve().parent.parent
INTERIM = ML / "data/interim"
LEVELS = ["low", "medium", "high"]
CONFIDENT = 0.6
FOLDS = 5
SEED = 7


def load() -> tuple[pd.DataFrame, list[str], np.ndarray]:
    features = pd.read_parquet(INTERIM / "features.parquet")
    labels = pd.read_csv(ML / "labels/rated.csv")[["item_id", "our_severity"]]
    embeddings = pd.read_parquet(INTERIM / "embeddings.parquet")[["item_id", "embedding"]]
    articles = pd.read_parquet(INTERIM / "articles.parquet")[["item_id", "gemini_severity"]]
    table = (
        features.merge(labels, on="item_id")
        .merge(embeddings, on="item_id")
        .merge(articles, on="item_id", how="left")
    )
    llm_path = INTERIM / "llm_ratings.parquet"
    llm = pd.read_parquet(llm_path)[["item_id", "llm_severity"]] if llm_path.exists() else None
    table = table.merge(llm, on="item_id", how="left") if llm is not None else table.assign(llm_severity=None)
    feature_columns = [c for c in features.columns if c not in ("item_id", "source", "group_id", "date")]
    vectors = np.vstack(table["embedding"].to_numpy())
    return table, feature_columns, vectors


def rules(row) -> str:
    """Baseline written from the rubric: no training."""
    import_side = (
        row["mt_tariff"]
        or row["mt_trade_defence"]
        or row["mt_import_ban"]
        or row["mt_import_quota"]
        or row["mt_document_rule"]
    )
    if (
        row["wood"]
        and row["by_our_market"]
        and import_side
        and (row["hits_home"] or row["hits_unnamed"])
        and (row["when_now"] or row["when_soon"])
    ):
        return "high"
    if row["wood"] and (row["by_our_market"] or row["mt_export_ban"] or row["mt_export_restriction"]):
        return "medium"
    return "low"


class Candidate:
    def __init__(self, name, use_embedding, make_model, pca=0):
        self.name, self.use_embedding, self.make_model, self.pca = name, use_embedding, make_model, pca

    def matrix(self, table, columns, vectors, train_index, rows):
        x = table.loc[rows, columns].to_numpy(dtype=float)
        if not self.use_embedding:
            return x, None
        if self.pca:
            reducer = PCA(n_components=self.pca, random_state=SEED).fit(vectors[train_index])
            return np.hstack([x, reducer.transform(vectors[rows])]), reducer
        return np.hstack([x, vectors[rows]]), None

    def fit_predict(self, table, columns, vectors, train_index, test_index):
        x_train, _ = self.matrix(table, columns, vectors, train_index, train_index)
        x_test, _ = self.matrix(table, columns, vectors, train_index, test_index)
        model = self.make_model().fit(x_train, table.loc[train_index, "our_severity"])
        probabilities = model.predict_proba(x_test)
        classes = list(model.classes_)
        best = probabilities.argmax(axis=1)
        return [classes[i] for i in best], probabilities.max(axis=1)


def logistic():
    return make_pipeline(StandardScaler(), LogisticRegression(C=0.5, class_weight="balanced", max_iter=5000))


def lightgbm():
    return LGBMClassifier(
        n_estimators=300,
        learning_rate=0.05,
        num_leaves=15,
        min_child_samples=5,
        class_weight="balanced",
        random_state=SEED,
        verbose=-1,
    )


CANDIDATES = [
    Candidate("Logistic regression (features)", False, logistic),
    Candidate("Logistic regression (features + embedding)", True, logistic),
    Candidate("LightGBM (features + 16 embedding components)", True, lightgbm, pca=16),
]
TRAINING_SETS = {
    "GTA + scan + archive": ("gta", "article", "archive"),
    "scan + archive": ("article", "archive"),
    "scan articles only": ("article",),
    "GTA only": ("gta",),
}
SAME_STORY = 0.92
# The cascade: the small model decides when it is this sure, else Gemini with the rubric (llm_rate.py).
CASCADE_MODEL = "LightGBM (features + 16 embedding components)"
CASCADE_TRAINING = "GTA + scan + archive"
CASCADE_THRESHOLDS = (0.6, 0.7, 0.8, 0.9)


def unlike(candidates: np.ndarray, test_index: np.ndarray, vectors: np.ndarray) -> np.ndarray:
    """Archive articles that aren't the same story as a test article (cosine similarity of their
    headlines below SAME_STORY), so a story never sits on both sides of the split."""
    if not len(candidates):
        return candidates
    a = vectors[candidates] / np.linalg.norm(vectors[candidates], axis=1, keepdims=True)
    b = vectors[test_index] / np.linalg.norm(vectors[test_index], axis=1, keepdims=True)
    return candidates[(a @ b.T).max(axis=1) < SAME_STORY]


def score(truth: list[str], predicted: list[str], confidence=None) -> dict:
    truth, predicted = np.array(truth), np.array(predicted)
    high = truth == "high"
    said_high = predicted == "high"
    result = {
        "high_recall": f"{int((said_high & high).sum())}/{int(high.sum())}",
        "high_recall_value": round(float((said_high & high).sum() / max(high.sum(), 1)), 3),
        "high_precision": round(float((said_high & high).sum() / max(said_high.sum(), 1)), 3),
        "macro_f1": round(
            float(f1_score(truth, predicted, labels=LEVELS, average="macro", zero_division=0)), 3
        ),
        "accuracy": round(float((truth == predicted).mean()), 3),
        "confusion": confusion_matrix(truth, predicted, labels=LEVELS).tolist(),
    }
    if confidence is not None:
        sure = np.array(confidence) >= CONFIDENT
        result["coverage"] = round(float(sure.mean()), 3)
        result["accuracy_when_sure"] = (
            round(float((truth[sure] == predicted[sure]).mean()), 3) if sure.any() else None
        )
    return result


def main() -> None:
    table, columns, vectors = load()
    articles = table.index[table["source"] == "article"].to_numpy()
    gta = table.index[table["source"] == "gta"].to_numpy()
    archive = table.index[table["source"] == "archive"].to_numpy()
    folds = list(
        StratifiedGroupKFold(n_splits=FOLDS, shuffle=True, random_state=SEED).split(
            articles, table.loc[articles, "our_severity"], table.loc[articles, "group_id"]
        )
    )
    truth = table.loc[articles, "our_severity"].tolist()
    results = {
        "Gemini (today's scan)": score(truth, table.loc[articles, "gemini_severity"].fillna("low").tolist()),
        "Rules (no training)": score(truth, [rules(table.loc[i]) for i in articles]),
    }
    confidences = {}
    per_article = {
        "item_id": table.loc[articles, "item_id"].tolist(),
        "ours": truth,
        "gemini": table.loc[articles, "gemini_severity"].fillna("low").tolist(),
    }
    for candidate in CANDIDATES:
        for set_name, sources in TRAINING_SETS.items():
            predicted = pd.Series(index=articles, dtype=object)
            confidence = pd.Series(index=articles, dtype=float)
            for train_fold, test_fold in folds:
                test_index = articles[test_fold]
                train_index = np.union1d(
                    gta if "gta" in sources else np.array([], dtype=int),
                    articles[train_fold] if "article" in sources else np.array([], dtype=int),
                )
                if "archive" in sources:
                    train_index = np.union1d(train_index, unlike(archive, test_index, vectors))
                labels, sure = candidate.fit_predict(table, columns, vectors, train_index, test_index)
                predicted[test_index], confidence[test_index] = labels, sure
            results[f"{candidate.name}, {set_name}"] = score(truth, predicted.tolist(), confidence.tolist())
            per_article[f"{candidate.name}, {set_name}"] = predicted.tolist()
            confidences[f"{candidate.name}, {set_name}"] = confidence.tolist()

    llm = table.loc[articles, "llm_severity"]
    if llm.notna().all():
        results["Gemini with the rubric"] = score(truth, llm.tolist())
        per_article["gemini_rubric"] = llm.tolist()
        small = f"{CASCADE_MODEL}, {CASCADE_TRAINING}"
        for threshold in CASCADE_THRESHOLDS:
            sure = np.array(confidences[small]) >= threshold
            mixed = np.where(sure, per_article[small], llm.to_numpy())
            name = f"Cascade: small model when ≥{threshold}, else Gemini with the rubric ({1 - sure.mean():.0%} to Gemini)"
            results[name] = score(truth, mixed.tolist())

    out = ML / "models" / date.today().isoformat()
    out.mkdir(parents=True, exist_ok=True)
    # Every test article with our label, Gemini's and each model's, to read the misses.
    pd.DataFrame(per_article).to_csv(out / "predictions.csv", index=False, encoding="utf-8")
    (out / "metrics.json").write_text(json.dumps(results, indent=1), encoding="utf-8")
    counts = pd.Series(truth).value_counts()
    lines = [
        f"# Severity model: evaluation, {date.today().isoformat()}",
        "",
        (
            f"{len(articles)} rated articles ({counts.get('high', 0)} high, {counts.get('medium', 0)} medium,"
            f" {counts.get('low', 0)} low), {FOLDS}-fold cross-validation; {int((table['source'] == 'gta').sum())}"
            f" rated GTA measures and {int((table['source'] == 'archive').sum())} rated archive articles"
            " available for training (archive stories matching a test headline are left out)."
            " Labels: Claude by labels/RUBRIC.md v1 (not yet checked by a person)."
        ),
        "",
        "| Model, trained on | high recall | high precision | macro-F1 | accuracy | decides at ≥0.6 | accuracy then |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for name, r in results.items():
        lines.append(
            f"| {name} | {r['high_recall']} | {r['high_precision']} | {r['macro_f1']} | {r['accuracy']}"
            f" | {r.get('coverage', '')} | {r.get('accuracy_when_sure', '') or ''} |"
        )
    lines += ["", "Confusion (rows: our label low, medium, high; columns: predicted):", ""]
    for name, r in results.items():
        lines.append(f"- {name}: {r['confusion']}")
    (out / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
