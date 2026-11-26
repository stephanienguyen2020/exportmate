"""Order features job: fresh figures, features and risk scores for the pairs companies' orders need.

    uv run python -m trade_risk.order_features                    # monthly: orders' pairs and pairs scored before
    uv run python -m trade_risk.order_features --new              # backfill: orders' pairs with no score yet
    uv run python -m trade_risk.order_features --pair US:VN:441231 # one pair: destination country,
                                                                  # exporting country, HS code
    uv run python -m trade_risk.order_features --rescore          # a new model: score saved features again
    uv run python -m trade_risk.order_features --cases            # copy the case list only

Writes the app's trade risk tables (Postgres, DATABASE_URL) except `order_trade_pairs`, which the
backend keeps and this job reads for the pairs to score:
1. For each pair, downloads from UN Comtrade the months not yet in `import_figures`: the market's
   imports of the product from every exporter (the share and market features need all of them).
2. Where Comtrade has no full recent 12 months (and the 12 before them), uses BACI's latest year.
3. Saves the figures to `import_figures`.
4. Computes the model's features exactly as `features.py` does, a 12-month total standing for a
   year, into `trade_flow_features`; the history features from the case list, up to today.
5. Copies the case list to `trade_cases` (monthly runs, or when the table is empty).
6. Scores the pair with the saved model (`scoring.py`; the Vertex AI endpoint once training moves
   to Google Cloud) and adds a row to `trade_risk_scores` when the score, its figures or the model
   changed.

Countries are alpha-2 codes in Postgres and ISO alpha-3 inside the model; customs unions that open
cases as one market are EU, EAEU and GCC in both. The app shows scores and reasons, never the
figures (Comtrade's terms), so reasons that would quote a dollar amount are worded without it.
Design: docs/local/TRADE_DEFENCE_RISK_MODEL.md ("3. Order features").
"""

import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from datetime import date

import numpy as np
import pandas as pd
import psycopg
from psycopg.types.json import Jsonb

from trade_risk.cases import read_concordance, read_hs2012_codes
from trade_risk.common import (
    BACI_CODE_FIXES,
    BACI_ZIP,
    CASES_FILE,
    CUSTOMS_UNIONS,
    DATA_DIR,
    EXPORTER_TOTALS_FILE,
    LAST_TRADE_YEAR,
    ML_DIR,
    TRADE_FLOWS_FILE,
)
from trade_risk.explain import REASON_TEXT
from trade_risk.features import FEATURES, history_features, trade_features
from trade_risk.scoring import SavedModel, latest_version_dir

COMTRADE_API = "https://comtradeapi.un.org/data/v1/get/C/M/HS"
COMTRADE_EU_REPORTER = 97  # the EU reports its imports as one
COMTRADE_PERIODS_PER_CALL = 12
COMTRADE_PAUSE_SECONDS = 1.2
# Months asked for: the 48 the features need (latest 12, the 12 before, and 12 three years before)
# plus 3, as countries report two to four months late.
MONTHS_WANTED = 51
# Comtrade's latest complete 12 months must end this recently, or the pair falls back to BACI.
MAX_LAG_MONTHS = 9
REASON_LIMIT = 3
UNION_NAMES = {"EU": "the EU", "EAEU": "the Eurasian Economic Union", "GCC": "the Gulf states"}
SHORT_NAMES = {"USA": "the US", "GBR": "the UK", "VNM": "Vietnam", "KOR": "South Korea", "TWN": "Taiwan",
               "RUS": "Russia", "CHN": "China", "IRN": "Iran", "TUR": "Türkiye", "CZE": "Czechia"}
# Dollar amounts are Comtrade's figures: said in words instead.
NO_FIGURES_TEXT = {
    "import_value_usd": lambda x, r: f"{r['exporter']} is a large supplier of it to {r['market']}",
    "market_import_value_usd": lambda x, r: f"{r['market']} is a large importer of it",
}


@dataclass(frozen=True)
class Pair:
    market: str  # alpha-2, or EU / EAEU / GCC
    exporter: str  # alpha-2
    hs6: str  # the order's code


@dataclass
class Countries:
    """Alpha-2, alpha-3 and Comtrade/BACI numeric codes, from BACI's country list."""

    iso3_of: dict[str, str]
    iso2_of: dict[str, str]
    numeric_of: dict[str, int]  # alpha-3 -> numeric
    iso3_of_numeric: dict[int, str]
    names: dict[str, str]  # alpha-3 -> display name

    @classmethod
    def load(cls) -> "Countries":
        archive = zipfile.ZipFile(BACI_ZIP)
        name = next(n for n in archive.namelist() if n.startswith("country_codes"))
        table = pd.read_csv(archive.open(name), keep_default_na=False)
        table["iso3"] = table["country_iso3"].replace(BACI_CODE_FIXES)
        table.loc[table["iso3"] == "TWN", "country_iso2"] = "TW"
        table = table[(table["iso3"] != "") & (table["country_iso2"] != "")]
        return cls(
            iso3_of=dict(zip(table["country_iso2"], table["iso3"])),
            iso2_of=dict(zip(table["iso3"], table["country_iso2"])),
            numeric_of=dict(zip(table["iso3"], table["country_code"].astype(int))),
            iso3_of_numeric=dict(zip(table["country_code"].astype(int), table["iso3"])),
            names={**dict(zip(table["iso3"], table["country_name"])), **SHORT_NAMES, **UNION_NAMES},
        )

    def model_market(self, alpha2: str) -> str | None:
        """The market as the model knows it: a customs union, or the country's alpha-3."""
        if alpha2 in CUSTOMS_UNIONS:
            return alpha2
        iso3 = self.iso3_of.get(alpha2)
        union = next((u for u, members in CUSTOMS_UNIONS.items() if iso3 in members), None)
        return union or iso3

    def app_code(self, model_code: str) -> str | None:
        return model_code if model_code in CUSTOMS_UNIONS else self.iso2_of.get(model_code)


def app_market(alpha2: str, countries: Countries) -> str | None:
    """Destination country -> the market stored in Postgres (a union, or the country)."""
    market = countries.model_market(alpha2.upper())
    return countries.app_code(market) if market else None


# ---------------------------------------------------------------- HS codes

class ModelProducts:
    """The order's HS code (HS 2022, as companies write them today) -> the HS 2012 code the model
    and the case list use."""

    def __init__(self):
        self.hs2012 = read_hs2012_codes()
        # WITS lists one HS 2012 code for each newer code.
        self.tables = {}
        for edition in ("H6", "H5"):
            table = read_concordance(f"Concordance_{edition}_to_H4.zip")
            self.tables[edition] = dict(zip(table.iloc[:, 0], table.iloc[:, 1]))

    def model_code(self, hs6: str) -> str | None:
        """HS 2022 first, then HS 2017; a code already in HS 2012 stays as it is."""
        for edition in ("H6", "H5"):
            if hs6 in self.tables[edition]:
                return self.tables[edition][hs6]
        return hs6 if hs6 in self.hs2012 else None


# ---------------------------------------------------------------- Comtrade

def months_back(end: date, count: int) -> list[str]:
    """`count` months ending with `end`'s month, oldest first, as YYYYMM."""
    index = end.year * 12 + end.month - 1
    return [f"{(i // 12):04d}{(i % 12) + 1:02d}" for i in range(index - count + 1, index + 1)]


def shift_month(period: str, months: int) -> str:
    index = int(period[:4]) * 12 + int(period[4:]) - 1 + months
    return f"{index // 12:04d}{index % 12 + 1:02d}"


def comtrade_reporters(market: str, countries: Countries) -> list[int]:
    if market == "EU":
        return [COMTRADE_EU_REPORTER]
    if market in CUSTOMS_UNIONS:
        return sorted(countries.numeric_of[m] for m in CUSTOMS_UNIONS[market] if m in countries.numeric_of)
    return [countries.numeric_of[market]]


def comtrade_key() -> str:
    key = os.environ.get("COMTRADE_API_KEY")
    if key:
        return key
    for env_file in (ML_DIR / ".env", DATA_DIR.parent / ".env"):
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                name, _, value = line.partition("=")
                if name.strip() == "COMTRADE_API_KEY":
                    return value.strip()
    raise RuntimeError("COMTRADE_API_KEY is not set (environment or ml/.env)")


def comtrade_call(params: dict, key: str) -> list[dict]:
    url = f"{COMTRADE_API}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, headers={"Ocp-Apim-Subscription-Key": key, "User-Agent": "exportmate"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                body = json.loads(response.read())
            time.sleep(COMTRADE_PAUSE_SECONDS)
            return body.get("data") or []
        except urllib.error.HTTPError as error:
            if error.code in (429, 500, 502, 503, 504) and attempt < 3:
                time.sleep(5 * (attempt + 1))
                continue
            raise
    return []


def fetch_comtrade(market: str, hs6: str, periods: list[str], countries: Countries, key: str) -> pd.DataFrame:
    """Monthly imports of `hs6` into `market` from every exporter, as model codes. Columns: period
    (YYYYMM), exporter (alpha-3), value_usd, tonnes."""
    rows = []
    reporters = comtrade_reporters(market, countries)
    for start in range(0, len(periods), COMTRADE_PERIODS_PER_CALL):
        chunk = periods[start:start + COMTRADE_PERIODS_PER_CALL]
        rows += comtrade_call({
            "reporterCode": ",".join(map(str, reporters)), "period": ",".join(chunk), "cmdCode": hs6,
            "flowCode": "M", "customsCode": "C00", "motCode": "0", "partner2Code": "0",
            "includeDesc": "false",
        }, key)
    frame = pd.DataFrame(rows)
    if frame.empty:
        return pd.DataFrame(columns=["period", "exporter", "value_usd", "tonnes"])
    # One total per partner: no breakdowns by customs procedure or transport, no "World" row.
    frame = frame[(frame["customsCode"] == "C00") & (frame["motCode"] == 0) & (frame["partner2Code"] == 0)
                  & (frame["mosCode"].astype(str) == "0") & (frame["partnerCode"] != 0)]
    frame = frame.assign(exporter=frame["partnerCode"].map(countries.iso3_of_numeric).replace(BACI_CODE_FIXES))
    frame = frame.dropna(subset=["exporter"])
    if market in CUSTOMS_UNIONS:  # trade inside the union isn't an import into it
        frame = frame[~frame["exporter"].isin(CUSTOMS_UNIONS[market])]
    # Some countries (the US) report no weight and Comtrade estimates one from a single price per
    # product, which would make every exporter's price the market's: such weights count as missing.
    reported = (frame["netWgt"] > 0) & ~frame["isNetWgtEstimated"].fillna(False).astype(bool)
    frame["tonnes"] = frame["netWgt"].where(reported) / 1000
    grouped = frame.groupby(["period", "exporter"], as_index=False).agg(
        value_usd=("primaryValue", "sum"), tonnes=("tonnes", lambda t: t.sum(min_count=1)))
    return grouped


def windows(months_present: set[str], today: date) -> dict[int, list[str]] | None:
    """The 12-month windows the features need, ending at the latest month with figures: offset 0 is
    the latest 12 months, 1 the 12 before, 3 three years before. None when the latest two windows
    aren't complete or end too long ago (the pair falls back to BACI)."""
    if not months_present:
        return None
    latest = max(months_present)
    if latest < months_back(today, MAX_LAG_MONTHS)[0]:
        return None
    result = {}
    for offset in (0, 1, 2, 3):
        months = [shift_month(latest, -12 * offset - i) for i in range(11, -1, -1)]
        if all(m in months_present for m in months):
            result[offset] = months
    return result if 0 in result and 1 in result else None


# ---------------------------------------------------------------- one pair

@dataclass
class Figures:
    trade: pd.DataFrame  # model panel input: market, exporter, hs6, year, value_usd, tonnes
    exporter_totals: pd.DataFrame  # exporter, hs6, year, world_value_usd
    year: int  # the "year" label of the latest window
    data_from: str
    data_to: str
    data_source: str
    to_save: pd.DataFrame  # rows for import_figures


def baci_rows(market: str, hs6: str) -> pd.DataFrame:
    return pd.read_parquet(TRADE_FLOWS_FILE, filters=[("market", "==", market), ("hs6", "==", hs6)])


def exporter_totals_rows(hs6: str) -> pd.DataFrame:
    return pd.read_parquet(EXPORTER_TOTALS_FILE, filters=[("hs6", "==", hs6)])


def comtrade_figures(pair: Pair, market: str, model_hs6: str, stored: pd.DataFrame, countries: Countries,
                     key: str | None, today: date) -> Figures | None:
    wanted = months_back(date(today.year, today.month, 1) - pd.DateOffset(months=1), MONTHS_WANTED)
    have = set(stored["period"].str.replace("-", "")) if not stored.empty else set()
    missing = [m for m in wanted if m not in have]
    fetched = pd.DataFrame(columns=["period", "exporter", "value_usd", "tonnes"])
    if missing and key:
        fetched = fetch_comtrade(market, pair.hs6, missing, countries, key)
    old = stored.assign(period=stored["period"].str.replace("-", ""),
                        exporter=stored["exporter"].map(countries.iso3_of))[["period", "exporter", "value_usd", "tonnes"]]
    parts = [frame for frame in (old, fetched) if not frame.empty]
    monthly = (pd.concat(parts, ignore_index=True).drop_duplicates(["period", "exporter"], keep="last")
               if parts else fetched)
    found = windows(set(monthly["period"]), today)
    to_save = fetched.assign(period=fetched["period"].str[:4] + "-" + fetched["period"].str[4:], period_kind="month",
                             source="comtrade")
    if found is None:
        return Figures(pd.DataFrame(), pd.DataFrame(), 0, "", "", "", to_save)
    latest_year = int(found[0][-1][:4])
    parts = []
    for offset, months in found.items():
        window = monthly[monthly["period"].isin(months)]
        totals = window.groupby("exporter", as_index=False).agg(
            value_usd=("value_usd", "sum"), tonnes=("tonnes", lambda t: t.sum(min_count=1)))
        parts.append(totals.assign(year=latest_year - offset))
    trade = pd.concat(parts, ignore_index=True).assign(market=market, hs6=model_hs6)
    # The exporter's sales to the whole world: BACI's latest two years (Comtrade would need a call
    # per exporting country).
    totals = exporter_totals_rows(model_hs6)
    totals = totals[totals["year"].isin([LAST_TRADE_YEAR, LAST_TRADE_YEAR - 1])]
    totals = totals.assign(year=totals["year"] - LAST_TRADE_YEAR + latest_year)
    first, last = found[0][0], found[0][-1]
    return Figures(trade, totals, latest_year, f"{first[:4]}-{first[4:]}", f"{last[:4]}-{last[4:]}", "comtrade", to_save)


def baci_figures(market: str, model_hs6: str, baci: pd.DataFrame) -> Figures:
    rows = baci[(baci["hs6"] == model_hs6) & (baci["year"] >= LAST_TRADE_YEAR - 3)]
    totals = exporter_totals_rows(model_hs6)
    to_save = rows.assign(period=rows["year"].astype(str), period_kind="year", source="baci")
    year = str(LAST_TRADE_YEAR)
    return Figures(rows, totals, LAST_TRADE_YEAR, year, year, "baci", to_save)


def reasons_for(row: pd.Series, contributions: np.ndarray, features: list[str], names: dict) -> list[dict]:
    worded = row.copy()
    worded["market"] = names.get(row["market"], row["market"])
    worded["exporter"] = names.get(row["exporter"], row["exporter"])
    result = []
    for index in np.argsort(-contributions):
        if contributions[index] <= 0 or len(result) == REASON_LIMIT:
            break
        feature = features[index]
        value = row[feature]
        if value is None or (isinstance(value, float) and np.isnan(value)):
            continue
        text = (NO_FIGURES_TEXT.get(feature) or REASON_TEXT.get(feature, lambda x, r: None))(value, worded)
        if text:
            result.append({"feature": feature, "text": text[0].upper() + text[1:], "contribution": round(float(contributions[index]), 4)})
    return result


def json_value(value) -> float | None:
    return None if value is None or (isinstance(value, float) and np.isnan(value)) else float(value)


# ---------------------------------------------------------------- Postgres

def connect() -> psycopg.Connection:
    url = os.environ.get("DATABASE_URL", "postgresql://exportmate:exportmate@127.0.0.1:5433/exportmate")
    return psycopg.connect(url.replace("postgresql+psycopg://", "postgresql://"))


def stored_months(db: psycopg.Connection, pair: Pair) -> pd.DataFrame:
    rows = db.execute(
        "SELECT exporter, period, value_usd, tonnes FROM import_figures "
        "WHERE market = %s AND hs6 = %s AND source = 'comtrade'", (pair.market, pair.hs6)).fetchall()
    return pd.DataFrame(rows, columns=["exporter", "period", "value_usd", "tonnes"])


def save_figures(db: psycopg.Connection, pair: Pair, rows: pd.DataFrame, countries: Countries) -> None:
    if rows.empty:
        return
    with db.cursor() as cursor:
        cursor.executemany(
            "INSERT INTO import_figures (market, exporter, hs6, period, source, period_kind, value_usd, tonnes) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (market, exporter, hs6, period, source) "
            "DO UPDATE SET value_usd = EXCLUDED.value_usd, tonnes = EXCLUDED.tonnes, fetched_at = now()",
            [(pair.market, countries.iso2_of[r.exporter], pair.hs6, r.period, r.source, r.period_kind,
              float(r.value_usd), json_value(r.tonnes))
             for r in rows.itertuples() if r.exporter in countries.iso2_of])


def save_features(db: psycopg.Connection, pair: Pair, model_hs6: str, row: pd.Series, figures: Figures) -> None:
    features = {f: json_value(row[f]) for f in FEATURES}
    db.execute(
        "INSERT INTO trade_flow_features (market, exporter, hs6, model_hs6, features, data_from, data_to, data_source) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (market, exporter, hs6) DO UPDATE SET "
        "model_hs6 = EXCLUDED.model_hs6, features = EXCLUDED.features, data_from = EXCLUDED.data_from, "
        "data_to = EXCLUDED.data_to, data_source = EXCLUDED.data_source, updated_at = now()",
        (pair.market, pair.exporter, pair.hs6, model_hs6, Jsonb(features), figures.data_from, figures.data_to,
         figures.data_source))


def save_score(db: psycopg.Connection, pair: Pair, result: dict) -> bool:
    """Adds a row when something changed since the pair's latest score; True if it did."""
    latest = db.execute(
        "SELECT level, score, model_version, data_to, note FROM trade_risk_scores "
        "WHERE market = %s AND exporter = %s AND hs6 = %s ORDER BY scored_at DESC LIMIT 1",
        (pair.market, pair.exporter, pair.hs6)).fetchone()
    current = (result["level"], result.get("score"), result["model_version"], result.get("data_to"), result.get("note"))
    if latest and latest[0] == current[0] and latest[2] == current[2] and latest[3] == current[3] and latest[4] == current[4] \
            and (latest[1] is None) == (current[1] is None) and (latest[1] is None or abs(latest[1] - current[1]) < 1e-9):
        return False
    db.execute(
        "INSERT INTO trade_risk_scores (id, market, exporter, hs6, model_hs6, level, score, percentile, reasons, note, "
        "model_version, data_from, data_to, data_source) VALUES (gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s, %s, "
        "%s, %s, %s, %s, %s)",
        (pair.market, pair.exporter, pair.hs6, result.get("model_hs6"), result["level"], result.get("score"),
         result.get("percentile"), Jsonb(result.get("reasons", [])), result.get("note"), result["model_version"],
         result.get("data_from"), result.get("data_to"), result.get("data_source")))
    return True


def save_cases(db: psycopg.Connection, cases: pd.DataFrame, countries: Countries) -> int:
    table = cases.assign(market=cases["market"].map(countries.app_code), exporter=cases["exporter"].map(countries.iso2_of))
    table = table.dropna(subset=["market", "exporter", "opened_on"]).drop_duplicates(["case_id", "market", "exporter", "hs6"])
    date_or_none = lambda d: None if pd.isna(d) else d.date()
    with db.cursor() as cursor:
        cursor.execute("DELETE FROM trade_cases")
        with cursor.copy("COPY trade_cases (case_id, market, exporter, hs6, kind, opened_on, final_measure_on, revoked_on, "
                         "measure_status, duty_pct, product, source) FROM STDIN") as copy:
            for r in table.itertuples():
                copy.write_row((r.case_id, r.market, r.exporter, r.hs6, r.kind, r.opened_on.date(),
                                date_or_none(r.final_measure_on), date_or_none(r.revoked_on), r.measure_status,
                                json_value(r.duty_pct), r.product, r.source))
    return len(table)


# ---------------------------------------------------------------- the job

class Job:
    def __init__(self, today: date, use_comtrade: bool = True):
        self.today = today
        self.countries = Countries.load()
        self.products = ModelProducts()
        self.cases = pd.read_parquet(CASES_FILE)
        self.case_markets = set(self.cases["market"])
        self.model = SavedModel(latest_version_dir())
        self.key = comtrade_key() if use_comtrade else None

    def no_data(self, pair: Pair, note: str, model_hs6: str | None = None, level: str = "no_data") -> dict:
        return {"level": level, "note": note, "model_version": self.model.version, "model_hs6": model_hs6}

    def run_pair(self, db: psycopg.Connection, pair: Pair) -> dict:
        market = self.countries.model_market(pair.market)
        exporter = self.countries.iso3_of.get(pair.exporter)
        if not market or not exporter:
            return self.no_data(pair, "Unknown market or exporting country.")
        model_hs6 = self.products.model_code(pair.hs6)
        if not model_hs6:
            return self.no_data(pair, f"HS {pair.hs6} isn't a known product code.")
        if market not in self.case_markets:
            name = self.countries.names.get(market, market)
            return self.no_data(pair, f"{name} has opened no anti-dumping or anti-subsidy cases in our records.",
                                model_hs6, level="low")
        baci = baci_rows(market, model_hs6)
        figures = comtrade_figures(pair, market, pair.hs6, stored_months(db, pair), self.countries, self.key, self.today)
        save_figures(db, pair, figures.to_save, self.countries)
        if figures.trade.empty:
            # Comtrade's latest 12 months aren't complete or recent: BACI's latest year.
            figures = baci_figures(market, model_hs6, baci)
            save_figures(db, pair, figures.to_save, self.countries)
        else:
            figures.trade["hs6"] = model_hs6
        return self.score(db, pair, market, exporter, model_hs6, figures)

    def score(self, db, pair: Pair, market: str, exporter: str, model_hs6: str, figures: Figures) -> dict:
        panel = trade_features(figures.trade, figures.exporter_totals, years=[figures.year]) if not figures.trade.empty else None
        match = panel[panel["exporter"] == exporter] if panel is not None and not panel.empty else None
        if match is None or match.empty:
            sold = figures.trade[(figures.trade["exporter"] == exporter) & (figures.trade["year"] == figures.year)]["value_usd"].sum() \
                if not figures.trade.empty else 0
            note = ("Imports under $1M a year: too small for the model to score." if sold > 0
                    else "No recorded imports of this product from this country in the latest figures.")
            # Older features would otherwise be scored again by --rescore.
            db.execute("DELETE FROM trade_flow_features WHERE market = %s AND exporter = %s AND hs6 = %s",
                       (pair.market, pair.exporter, pair.hs6))
            return {**self.no_data(pair, note, model_hs6), "data_from": figures.data_from or None,
                    "data_to": figures.data_to or None, "data_source": figures.data_source or None}
        frame = history_features(match.reset_index(drop=True), self.cases, self.today.year)
        row = frame.iloc[0]
        save_features(db, pair, model_hs6, row, figures)
        score = float(self.model.score(frame)[0])
        percentile = self.model.percentile(np.array([score]))
        contributions = self.model.contributions(frame)[0]
        return {
            "level": str(self.model.level(np.array([score]))[0]), "score": score,
            "percentile": None if percentile is None else float(percentile[0]),
            "reasons": reasons_for(row, contributions, self.model.features, self.countries.names),
            "model_version": self.model.version, "model_hs6": model_hs6,
            "data_from": figures.data_from, "data_to": figures.data_to, "data_source": figures.data_source,
        }

    def rescore_pair(self, db: psycopg.Connection, pair: Pair) -> dict | None:
        """Score the saved features again (a new model), without downloading."""
        saved = db.execute("SELECT model_hs6, features, data_from, data_to, data_source FROM trade_flow_features "
                           "WHERE market = %s AND exporter = %s AND hs6 = %s",
                           (pair.market, pair.exporter, pair.hs6)).fetchone()
        if not saved:
            return None
        model_hs6, features, data_from, data_to, data_source = saved
        row = pd.Series({**{f: np.nan if features.get(f) is None else features[f] for f in FEATURES},
                         "market": self.countries.model_market(pair.market), "exporter": self.countries.iso3_of[pair.exporter],
                         "hs6": model_hs6})
        frame = pd.DataFrame([row])
        score = float(self.model.score(frame)[0])
        percentile = self.model.percentile(np.array([score]))
        return {
            "level": str(self.model.level(np.array([score]))[0]), "score": score,
            "percentile": None if percentile is None else float(percentile[0]),
            "reasons": reasons_for(row, self.model.contributions(frame)[0], self.model.features, self.countries.names),
            "model_version": self.model.version, "model_hs6": model_hs6,
            "data_from": data_from, "data_to": data_to, "data_source": data_source,
        }


def parse_pair(text: str, countries: Countries) -> Pair:
    """DESTINATION:EXPORTER:HS, alpha-2 countries and an HS code of at least 6 digits."""
    destination, exporter, hs = text.split(":")
    digits = "".join(c for c in hs if c.isdigit())
    market = app_market(destination, countries)
    if not market or len(digits) < 6:
        raise ValueError(f"not a pair: {text}")
    return Pair(market, exporter.upper(), digits[:6])


def known_pairs(db: psycopg.Connection) -> list[Pair]:
    """Monthly: orders' pairs, and pairs scored before (what-ifs; orders since deleted)."""
    rows = db.execute("SELECT market, exporter, hs6 FROM order_trade_pairs UNION "
                      "SELECT market, exporter, hs6 FROM trade_risk_scores ORDER BY 1, 2, 3").fetchall()
    return [Pair(*row) for row in rows]


def new_pairs(db: psycopg.Connection) -> list[Pair]:
    """Orders' pairs with no score yet (the backend saves them with each order)."""
    rows = db.execute(
        "SELECT DISTINCT p.market, p.exporter, p.hs6 FROM order_trade_pairs p WHERE NOT EXISTS ("
        "SELECT 1 FROM trade_risk_scores s WHERE s.market = p.market AND s.exporter = p.exporter "
        "AND s.hs6 = p.hs6) ORDER BY 1, 2, 3").fetchall()
    return [Pair(*row) for row in rows]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pair", action="append", default=[], help="DESTINATION:EXPORTER:HS, e.g. US:VN:441231")
    parser.add_argument("--new", action="store_true", help="score orders' pairs that have no score yet")
    parser.add_argument("--rescore", action="store_true", help="score every saved pair's features again")
    parser.add_argument("--cases", action="store_true", help="copy the case list to trade_cases only")
    parser.add_argument("--no-comtrade", action="store_true", help="use BACI only (no Comtrade calls)")
    args = parser.parse_args()
    with connect() as db:
        if args.cases:
            countries = Countries.load()
            print(f"trade_cases: {save_cases(db, pd.read_parquet(CASES_FILE), countries):,} rows")
            return
        job = Job(date.today(), use_comtrade=not (args.no_comtrade or args.rescore))
        print(f"model {job.model.version}")
        empty_cases = db.execute("SELECT NOT EXISTS (SELECT 1 FROM trade_cases)").fetchone()[0]
        if not (args.pair or args.new) or empty_cases:
            print(f"trade_cases: {save_cases(db, job.cases, job.countries):,} rows")
            db.commit()
        if args.pair:
            pairs = [parse_pair(p, job.countries) for p in args.pair]
        else:
            pairs = new_pairs(db) if args.new else known_pairs(db)
        for pair in pairs:
            try:
                result = job.rescore_pair(db, pair) if args.rescore else job.run_pair(db, pair)
                if result is None:
                    print(f"{pair}: no saved features")
                    continue
                changed = save_score(db, pair, result)
                db.commit()
                print(f"{pair.market} {pair.exporter} {pair.hs6}: {result['level']}"
                      f"{'' if result.get('score') is None else f' ({result['score']:.4f})'}"
                      f" {result.get('data_source') or ''} {result.get('data_from') or ''}..{result.get('data_to') or ''}"
                      f"{'' if changed else ' (unchanged)'} {result.get('note') or ''}", flush=True)
            except Exception as error:  # one pair's failure never stops the others
                db.rollback()
                print(f"{pair}: failed: {error!r}", flush=True)


if __name__ == "__main__":
    main()
