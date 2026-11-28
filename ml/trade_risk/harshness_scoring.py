"""Harshness scores for the trade measures news articles report: the news scan writes each measure down
(the alert's `measure`) and starts the Order features job with it (`--measure`); this scores it.

1. The measure becomes rows, one per market x origin x HS 6 (MAX_ROWS at most): a 4-digit HS code becomes
   the 6-digit codes under it that the market imports most from the named origins (BACI's latest year),
   and a measure on every country (a safeguard) is scored for the market's SAFEGUARD_TOP_ORIGINS biggest
   suppliers of the product, as in training.
2. Each row gets the harshness model's features with the code that built its training rows
   (`harshness.py`): the trade risk features of the pair (the Order features job's figures: Comtrade's
   latest 12 months, else BACI's latest year), the case's history up to today, the market's shape and
   how often imports fell after the market's earlier cases.
3. The saved harshness model (`harshness final`, models/harshness/<run>/) scores each row, and the row is
   added to `measure_scores` (Postgres) with its level and reasons.

Only anti-dumping, anti-subsidy and safeguard measures are the model's; other kinds are left for Gemini.
Scores and reasons only, never the figures (Comtrade's terms). Design: ml/docs/HARSHNESS_MODEL.md.
"""

import argparse
import json
from dataclasses import dataclass
from datetime import date

import numpy as np
import pandas as pd
import psycopg
from psycopg.types.json import Jsonb

from trade_risk.common import LAST_TRADE_YEAR, TRADE_FLOWS_FILE
from trade_risk.harshness import (
    HARSHNESS_FILE,
    HARSHNESS_MODELS_DIR,
    MARKET_SHAPE_FEATURES,
    SAFEGUARD_TOP_ORIGINS,
    market_shape,
    past_duty_rates,
    past_fall_rates,
)
from trade_risk.harshness_cases import HARSHNESS_CASES_FILE
from trade_risk.order_features import Countries, Job, Pair, app_market, connect, json_value, reasons_for
from trade_risk.scoring import SavedModel, latest_version_dir

# The scan's words for the kinds the model scores, and the case table's.
MODEL_KINDS = {"anti_dumping": "AD", "anti_subsidy": "CVD", "safeguard": "SG"}
MAX_ROWS = 20
CODES_PER_HEADING = 5


def percent(x: float) -> str:
    return f"{x:.0%}"


# The harshness model's own features, in words (the trade risk features use explain.REASON_TEXT).
HARSHNESS_REASON_TEXT = {
    "named_share_of_market": lambda x, r: f"the countries this case names supply {percent(x)} of {r['market']}'s imports of it" if x >= 0.5 else None,
    "top_rest_share_of_market": lambda x, r: f"no other supplier holds more than {percent(x)} of {r['market']}'s imports of it" if x < 0.1 else None,
    "rest_suppliers_over_1pct": lambda x, r: f"only {x:.0f} other countries supply over 1% of it" if x <= 5 else None,
    "market_fall_rate_before": lambda x, r: f"imports fell after {percent(x)} of {r['market']}'s past cases" if x >= 0.4 else None,
    "origin_fall_rate_before": lambda x, r: f"imports fell after {percent(x)} of past cases against {r['exporter']}" if x >= 0.4 else None,
    "chapter_fall_rate_before": lambda x, r: f"imports fell after {percent(x)} of past cases on products of HS chapter {r['hs6'][:2]}" if x >= 0.4 else None,
    "market_duty_rate_before": lambda x, r: f"{percent(x)} of {r['market']}'s past cases ended in a duty" if x >= 0.6 else None,
    "market_kind_duty_rate_before": lambda x, r: f"{percent(x)} of {r['market']}'s past cases of this kind ended in a duty" if x >= 0.6 else None,
    "origin_duty_rate_before": lambda x, r: f"{percent(x)} of past cases against {r['exporter']} ended in a duty" if x >= 0.6 else None,
    "market_chapter_duty_rate_before": lambda x, r: f"{percent(x)} of {r['market']}'s past cases on HS chapter {r['hs6'][:2]} ended in a duty" if x >= 0.6 else None,
    "origins_in_investigation": lambda x, r: f"the case names {x:.0f} countries" if x >= 3 else None,
    # Trade risk features worded for harshness: few suppliers means the named ones' sales fall more often.
    "market_supplier_count": lambda x, r: f"only {x:.0f} countries supply it to {r['market']}" if x <= 20 else None,
    "hs_chapter": lambda x, r: None,
}


@dataclass(frozen=True)
class Measure:
    """What the scan wrote down (backend news_scan_rules.clean_measure), with the article it came from."""

    article_id: str
    kind: str
    stage: str
    markets: tuple[str, ...]  # alpha-2, or EU
    origins: tuple[str, ...]  # alpha-2; none: every country
    product_hs: tuple[str, ...]  # 4 or 6 digits

    @classmethod
    def from_json(cls, text: str) -> "Measure":
        data = json.loads(text)
        return cls(
            article_id=str(data["articleId"]), kind=str(data["kind"]), stage=str(data.get("stage") or "unknown"),
            markets=tuple(m.upper() for m in data.get("markets") or []),
            origins=tuple(o.upper() for o in data.get("origins") or []),
            product_hs=tuple("".join(c for c in h if c.isdigit()) for h in data.get("productHs") or []),
        )


@dataclass(frozen=True)
class Row:
    pair: Pair  # app codes: market, exporter alpha-2, HS 6
    market: str  # the model's codes: alpha-3 or a union
    exporter: str


def market_supplies(market: str) -> pd.DataFrame:
    """BACI's latest year of the market's imports: exporter (alpha-3), hs6 (HS 2012), value_usd."""
    rows = pd.read_parquet(TRADE_FLOWS_FILE, filters=[("market", "==", market), ("year", "==", LAST_TRADE_YEAR)])
    return rows[["exporter", "hs6", "value_usd"]]


def measure_rows(measure: Measure, countries: Countries, supplies) -> tuple[list[Row], list[str]]:
    """The rows to score, and what was left out and why. `supplies(model_market)` gives a market's imports
    (market_supplies)."""
    rows: list[Row] = []
    origins = [countries.iso3_of.get(o) for o in measure.origins]
    skipped = [f"unknown origin {o}" for o, iso3 in zip(measure.origins, origins) if not iso3]
    origins = [o for o in origins if o]
    for code in measure.markets:
        app = app_market(code, countries)
        market = countries.model_market(code) if app else None
        if not market:
            skipped.append(f"unknown market {code}")
            continue
        supply = supplies(market)
        for hs in measure.product_hs:
            if len(hs) == 6:
                codes = [hs]
            else:  # a heading: the codes under it the market imports most from the named origins
                under = supply[supply["hs6"].str.startswith(hs)]
                if origins:
                    under = under[under["exporter"].isin(origins)]
                codes = under.groupby("hs6")["value_usd"].sum().nlargest(CODES_PER_HEADING).index.tolist()
                if not codes:
                    skipped.append(f"no imports under HS {hs}")
            for hs6 in codes:
                exporters = origins or (supply[supply["hs6"] == hs6].nlargest(SAFEGUARD_TOP_ORIGINS, "value_usd")["exporter"].tolist())
                for exporter in exporters:
                    alpha2 = countries.iso2_of.get(exporter)
                    if alpha2 and exporter != market:
                        rows.append(Row(Pair(app, alpha2, hs6), market, exporter))
    unique = list(dict.fromkeys(rows))
    if len(unique) > MAX_ROWS:
        skipped.append(f"{len(unique) - MAX_ROWS} rows over the limit of {MAX_ROWS}")
    return unique[:MAX_ROWS], skipped


def named_origins_now(cases: pd.DataFrame, market: str, model_hs6: str, today: date) -> set[str]:
    """Origins any case named on the market's product this year or last (training's `named_origins`)."""
    recent = cases[(cases["market"] == market) & (cases["hs6"] == model_hs6) & (cases["year"] >= today.year - 1)]
    return set(recent["exporter"])


class HarshnessScorer:
    def __init__(self, job: Job):
        self.job = job
        self.model = SavedModel(latest_version_dir(HARSHNESS_MODELS_DIR))
        self.cases = pd.read_parquet(HARSHNESS_CASES_FILE)
        self.history = pd.read_parquet(HARSHNESS_FILE)
        self.supplies: dict[str, pd.DataFrame] = {}

    def supply(self, market: str) -> pd.DataFrame:
        if market not in self.supplies:
            self.supplies[market] = market_supplies(market)
        return self.supplies[market]

    def already_scored(self, db: psycopg.Connection, measure: Measure) -> bool:
        return db.execute("SELECT EXISTS (SELECT 1 FROM measure_scores WHERE article_id = %s AND model_version = %s)",
                          (measure.article_id, self.model.version)).fetchone()[0]

    def score_measure(self, db: psycopg.Connection, measure: Measure) -> list[dict]:
        """Scores and saves every row of the measure; returns what was saved."""
        kind = MODEL_KINDS.get(measure.kind)
        if kind is None:
            return []
        rows, skipped = measure_rows(measure, self.job.countries, self.supply)
        if skipped:
            print(f"{measure.article_id}: left out {'; '.join(skipped)}")
        today = self.job.today
        # As in training: the origins the case names in its market, and the products it names per origin.
        origins = {m: len({r.exporter for r in rows if r.market == m}) for m in {r.market for r in rows}}
        products = {(r.market, r.exporter): 0 for r in rows}
        for r in rows:
            products[(r.market, r.exporter)] += 1
        results = []
        for r in rows:
            result = self.score_row(db, measure, kind, r, today, origins[r.market], products[(r.market, r.exporter)])
            save_measure_score(db, measure, r.pair, result)
            results.append({**result, "market": r.pair.market, "exporter": r.pair.exporter, "hs6": r.pair.hs6})
        return results

    def score_row(self, db, measure: Measure, kind: str, r: Row, today: date, origins: int, products: int) -> dict:
        model_hs6 = self.job.products.model_code(r.pair.hs6)
        if not model_hs6:
            return self.no_data(f"HS {r.pair.hs6} isn't a known product code.")
        figures = self.job.pair_figures(db, r.pair, r.market, model_hs6)
        frame, note = self.job.flow_row(db, r.pair, r.exporter, model_hs6, figures)
        if frame is None:
            return {**self.no_data(note, model_hs6), "data_from": figures.data_from or None,
                    "data_to": figures.data_to or None, "data_source": figures.data_source or None}
        row = frame.iloc[0].copy()
        safeguard = kind == "SG"
        case = pd.DataFrame([{"case_id": "new", "market": r.market, "kind": kind, "exporter": "ALL" if safeguard else r.exporter,
                              "hs6": model_hs6, "opened_on": pd.Timestamp(today), "year": today.year}])
        for name, value in past_duty_rates(case).iloc[0].items():
            if name != "case_id":
                row[name] = value
        fall_case = case.assign(exporter=r.exporter)
        for name, value in past_fall_rates(fall_case, self.history).iloc[0].items():
            if name != "case_id":
                row[name] = value
        row["is_anti_subsidy"] = float(kind == "CVD")
        row["is_safeguard"] = float(safeguard)
        row["origins_in_investigation"] = float(origins)
        row["products_in_investigation"] = float(products)
        names = {"ALL"} if safeguard else {r.exporter} | {self.job.countries.iso3_of.get(o, o) for o in measure.origins} \
            | named_origins_now(self.cases, r.market, model_hs6, today)
        before = figures.trade[figures.trade["year"] == figures.year]
        before_flows = dict(zip(before["exporter"], before["value_usd"]))
        shape = market_shape(before_flows, names, r.exporter)
        for name, value in zip(MARKET_SHAPE_FEATURES, shape):
            row[name] = value
        scored = pd.DataFrame([row])
        missing = [f for f in self.model.features if f not in scored]
        if missing:
            raise ValueError(f"features not built: {missing}")
        score = float(self.model.score(scored)[0])
        contributions = self.model.contributions(scored)[0]
        return {
            "level": str(self.model.level(np.array([score]))[0]), "score": score,
            "reasons": reasons_for(row, contributions, self.model.features, self.job.countries.names, HARSHNESS_REASON_TEXT),
            "model_version": self.model.version, "model_hs6": model_hs6,
            "data_from": figures.data_from, "data_to": figures.data_to, "data_source": figures.data_source,
        }

    def no_data(self, note: str, model_hs6: str | None = None) -> dict:
        return {"level": "no_data", "note": note, "model_version": self.model.version, "model_hs6": model_hs6}


def save_measure_score(db: psycopg.Connection, measure: Measure, pair: Pair, result: dict) -> None:
    db.execute(
        "INSERT INTO measure_scores (id, article_id, kind, stage, market, exporter, hs6, model_hs6, level, score, reasons, "
        "note, scored_by, model_version, data_from, data_to, data_source) VALUES (gen_random_uuid(), %s, %s, %s, %s, %s, %s, "
        "%s, %s, %s, %s, %s, 'model', %s, %s, %s, %s)",
        (measure.article_id, measure.kind, measure.stage, pair.market, pair.exporter, pair.hs6, result.get("model_hs6"),
         result["level"], json_value(result.get("score")), Jsonb(result.get("reasons", [])), result.get("note"),
         result["model_version"], result.get("data_from"), result.get("data_to"), result.get("data_source")))


def main() -> None:
    parser = argparse.ArgumentParser(description="Score the trade measures the news scan wrote down.")
    parser.add_argument("--measure", action="append", default=[], help='the measure as JSON, with its "articleId"')
    parser.add_argument("--no-comtrade", action="store_true", help="use BACI only (no Comtrade calls)")
    args = parser.parse_args()
    with connect() as db:
        scorer = HarshnessScorer(Job(date.today(), use_comtrade=not args.no_comtrade))
        print(f"harshness model {scorer.model.version}")
        for text in args.measure:
            try:
                measure = Measure.from_json(text)
                if measure.kind not in MODEL_KINDS:
                    print(f"{measure.article_id}: {measure.kind} isn't the model's kind")
                    continue
                if scorer.already_scored(db, measure):
                    print(f"{measure.article_id}: already scored by {scorer.model.version}")
                    continue
                results = scorer.score_measure(db, measure)
                db.commit()
                for r in results:
                    print(f"{measure.article_id} {r['market']} {r['exporter']} {r['hs6']}: {r['level']}"
                          f"{'' if r.get('score') is None else f' ({r['score']:.3f})'} {r.get('note') or ''}", flush=True)
            except Exception as error:  # noqa: BLE001 - one measure's failure never stops the others
                db.rollback()
                print(f"measure failed: {error!r}", flush=True)
