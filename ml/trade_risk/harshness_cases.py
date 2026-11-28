"""Case table for the harshness model (severity model v2): every anti-dumping, anti-subsidy and safeguard
case with its outcome, from four sources.

    uv run python -m trade_risk.harshness_cases download   # WTO portal and EU TRON -> data/raw/wto_trade_remedies, data/raw/eu_tron
    uv run python -m trade_risk.harshness_cases build      # -> data/interim/trade_risk/harshness_cases.parquet

Sources:
- TTBD anti-dumping and anti-subsidy cases (cases.parquet, the trade risk model's table), to 2024.
- TTBD safeguards (Global Safeguards Database): every origin at once, so exporter is "ALL".
- WTO Trade Remedies Data Portal (members' semi-annual reports): anti-dumping and anti-subsidy
  investigations with their conclusion, measure dates and HS codes. Complete for cases opened from
  2023 on; before that it keeps mainly cases whose duty was in force on or after 2020.
- EU TRON (the Commission's public case list): EU cases with initiation, provisional and definitive
  duty dates and CN codes.

A WTO or EU case is the same as a TTBD case when market, origin and kind match and the openings are
within SAME_CASE_DAYS. Then TTBD's rows are kept and the others fill what TTBD lacks: the outcome of
cases TTBD left open, and the provisional duty date. Cases only the WTO or EU list have are added.

outcome: "duty" (a final duty was imposed), "no_duty" (ended without one: negative, withdrawn, or a
TTBD case still without a final measure 2 years after it opened, when TTBD was last updated) or
"pending" (no decision known yet). Pending cases have no "ended in a duty" label.
"""

import argparse
import base64
import html
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

import numpy as np
import pandas as pd

from trade_risk.cases import (
    COUNTRY_ALIASES,
    HsConcordance,
    expand_exporters,
    first_date,
    map_products,
    normalise_country,
    product_code,
    read_country_names,
    read_hs2012_codes,
)
from trade_risk.common import CASES_FILE, INTERIM_DIR, RAW_DIR, TTBD_DIR

HARSHNESS_CASES_FILE = INTERIM_DIR / "harshness_cases.parquet"
WTO_DIR = RAW_DIR / "wto_trade_remedies"
EU_DIR = RAW_DIR / "eu_tron"
WTO_API = "https://trade-remedies.wto.org/en/api"
WTO_DOMAINS = {"antidumping": "AD", "cv": "CVD"}
EU_API = "https://tron.trade.ec.europa.eu/investigations/api/eucase"
USER_AGENT = {"User-Agent": "Mozilla/5.0 (exportmate research)"}
SAME_CASE_DAYS = 45
TTBD_LAST_UPDATE = pd.Timestamp("2024-12-31")
WTO_DATA_AS_OF = pd.Timestamp("2026-06-30")  # the portal's latest semi-annual reports
# A case is decided within about 18 months; one with no final measure 2 years after it opened ended without one.
DECIDED_WITHIN_DAYS = 730
MARKET_NAMES = {
    "european union": "EU", "eurasian economic union": "EAEU", "eurasian economic union (eaeu)": "EAEU",
    "chinese taipei": "TWN", "hong kong, china": "HKG", "macao, china": "MAC", "korea, republic of": "KOR",
    "türkiye": "TUR", "trinidad,tob": "TTO", "u.a.emirates": "ARE", "united states of america": "USA",
    "kingdom of saudi arabia": "SAU", "erga omnes": "ALL", "bahrain, kingdom of": "BHR", "bosnia and herzegovina": "BIH",
    "kuwait, the state of": "KWT", "moldova, republic of": "MDA", "saudi arabia, kingdom of": "SAU", "tanzania": "TZA",
    "venezuela, bolivarian republic of": "VEN",
}
SAFEGUARD_FILE = TTBD_DIR / "Global safeguard measures" / "GSGD-WTO.xls"


# ---------------------------------------------------------------- download

def fetch(url: str, data: bytes | None = None, headers: dict | None = None) -> bytes:
    for attempt in range(5):
        try:
            request = urllib.request.Request(url, data=data, headers={**USER_AGENT, **(headers or {})})
            body = urllib.request.urlopen(request, timeout=90).read()
            time.sleep(0.3)
            return body
        except urllib.error.HTTPError as error:
            if error.code == 404:
                raise
            print("retry", error.code, url, flush=True)
        except (urllib.error.URLError, TimeoutError) as error:
            print("retry", error, url, flush=True)
        time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"failed {url}")


def download_wto() -> None:
    """Every investigation's list row and detail page (HS codes, conclusion), and the portal's
    spreadsheet of investigations (measure dates). Files already saved are skipped."""
    filters = json.dumps({"years": [], "reportingMembers": [], "exportingMembers": [], "hsSections": [], "subjectProduct": "", "status": ""},
                         separators=(",", ":"))
    for domain in WTO_DOMAINS:
        folder = WTO_DIR / domain
        (folder / "details").mkdir(parents=True, exist_ok=True)
        sheet = folder / "investigations.xlsx"
        if not sheet.exists():
            portal = "antidumping" if domain == "antidumping" else "countervailing"
            encoded = base64.b64encode(filters.encode()).decode()
            sheet.write_bytes(fetch(f"https://trade-remedies.wto.org/en/{portal}/investigations/download/{encoded}"))
        list_file = folder / "list.json"
        if not list_file.exists():
            rows, page = [], 1
            while True:
                query = urllib.parse.urlencode({"page": page, "sort": "initiation_dt", "direction": "desc", "filters": filters})
                data = json.loads(fetch(f"{WTO_API}/{domain}/investigations?{query}", headers={"X-Requested-With": "XMLHttpRequest"}))
                rows += data["data"]
                if len(rows) >= data["total"] or not data["data"]:
                    break
                page += 1
            list_file.write_text(json.dumps(rows), encoding="utf-8")
        rows = json.loads(list_file.read_text(encoding="utf-8"))
        for index, row in enumerate(rows):
            target = folder / "details" / (urllib.parse.quote(row["code"], safe="") + ".html")
            if not target.exists():
                query = urllib.parse.urlencode({"investigation_stat": row["code"]})
                target.write_bytes(fetch(f"{WTO_API}/{domain}/investigation-details?{query}", headers={"X-Requested-With": "XMLHttpRequest"}))
            if index % 500 == 0:
                print(f"WTO {domain}: {index}/{len(rows)} details", flush=True)


def download_eu() -> None:
    (EU_DIR / "details").mkdir(parents=True, exist_ok=True)
    query = {"cncode": "", "casenumber": "", "productname": "", "country": "All countries", "measure": "All measures",
             "measuretype": "All types of measure", "status": "Any status", "proceeding": "All types of proceeding"}
    cases = json.loads(fetch(f"{EU_API}/search", json.dumps(query).encode(), {"Content-Type": "application/json"}))
    cases = list(cases.values()) if isinstance(cases, dict) else cases
    (EU_DIR / "list.json").write_text(json.dumps(cases), encoding="utf-8")
    ids = sorted({related["caseId"] for case in cases for related in case["relatedCases"]} | {case["caseInitId"] for case in cases})
    for case_id in ids:
        target = EU_DIR / "details" / f"{case_id}.json"
        if target.exists():
            continue
        try:
            target.write_bytes(fetch(f"{EU_API}/details/{case_id}"))
        except urllib.error.HTTPError:
            continue  # a related case without a public page
    print(f"EU TRON: {len(cases)} cases, {len(ids)} case pages")


# ---------------------------------------------------------------- read

def country_code(name: str, by_name: dict[str, str]) -> str | None:
    text = normalise_country(name)
    if text in MARKET_NAMES:
        return MARKET_NAMES[text]
    if text.startswith("gcc"):
        return "GCC"
    return by_name.get(text)


def page_text(raw: str) -> str:
    text = re.sub(r"<script.*?</script>|<style.*?</style>", " ", raw, flags=re.DOTALL)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", text))).strip()


def read_wto(by_name: dict[str, str]) -> pd.DataFrame:
    """One row per (investigation, HS code) with its conclusion and measure dates."""
    parts = []
    for domain, kind in WTO_DOMAINS.items():
        folder = WTO_DIR / domain
        rows = pd.DataFrame(json.loads((folder / "list.json").read_text(encoding="utf-8"))).rename(columns={"code": "portal_code"})
        sheet = pd.read_excel(folder / "investigations.xlsx")
        sheet = sheet.rename(columns={"Investigation number": "investigation_number", "Reporting member": "reporting_member",
                                      "Exporting member": "exporting_member", "Initiation date": "initiation",
                                      "Measure in force from": "measure_from", "Measure in force until": "measure_until"})
        sheet["initiation"] = pd.to_datetime(sheet["initiation"], errors="coerce")
        rows["initiation"] = pd.to_datetime(rows["initiation_dt"], format="%d/%m/%Y", errors="coerce")
        rows = rows.merge(sheet[["investigation_number", "reporting_member", "exporting_member", "initiation", "measure_from", "measure_until"]]
                          .drop_duplicates(["investigation_number", "reporting_member", "exporting_member", "initiation"]),
                          on=["investigation_number", "reporting_member", "exporting_member", "initiation"], how="left")
        codes = []
        for portal_code in rows["portal_code"]:
            path = folder / "details" / (urllib.parse.quote(portal_code, safe="") + ".html")
            text = page_text(path.read_text(encoding="utf-8", errors="replace")) if path.exists() else ""
            section = text.split("HS codes", 1)[1].split("Trade data", 1)[0] if "HS codes" in text else ""
            codes.append(sorted({c[:6] for c in re.findall(r"\b\d{6,10}\b", section)}))
        rows["codes"] = codes
        rows["kind"] = kind
        parts.append(rows)
    wto = pd.concat(parts, ignore_index=True)
    wto["market"] = [country_code(n, by_name) for n in wto["reporting_member"]]
    wto["exporter"] = [country_code(n, by_name) for n in wto["exporting_member"]]
    unknown = set(wto.loc[wto["market"].isna(), "reporting_member"]) | set(wto.loc[wto["exporter"].isna(), "exporting_member"])
    if unknown:
        print("WTO: unknown member names (rows dropped):", sorted(unknown)[:30])
    wto = wto.dropna(subset=["market", "exporter", "initiation"])
    conclusion = wto["conclusion"].fillna("").str.lower()
    # "Affirmative" is the investigators' finding; the duty is real only with a date it came into force.
    # India's finance ministry left 102 affirmative findings of 2019-2021 without a duty.
    decided = wto["initiation"] + pd.to_timedelta(DECIDED_WITHIN_DAYS, unit="D") <= WTO_DATA_AS_OF
    wto["outcome"] = np.select([wto["measure_from"].notna(), conclusion.isin(["negative", "withdrawn"]),
                                conclusion.eq("affirmative") & decided], ["duty", "no_duty", "no_duty"], "pending")
    wto["final_measure_on"] = pd.to_datetime(wto["measure_from"], errors="coerce")
    wto["revoked_on"] = pd.to_datetime(wto["measure_until"], errors="coerce")
    wto = wto.explode("codes").reset_index(drop=True).rename(columns={"codes": "code", "subject_product": "product", "initiation": "opened_on"})
    wto["case_id"] = "WTO-" + wto["kind"] + "-" + wto["portal_code"]
    print(f"WTO portal: {wto['case_id'].nunique():,} investigations, {wto['code'].notna().mean():.0%} of rows with an HS code")
    return wto[["case_id", "kind", "market", "exporter", "product", "opened_on", "final_measure_on", "revoked_on", "outcome", "code"]]


def eu_date(text) -> pd.Timestamp:
    return pd.to_datetime(text, format="%d %B %Y", errors="coerce") if isinstance(text, str) else pd.NaT


def read_eu(by_name: dict[str, str]) -> pd.DataFrame:
    """EU initial investigations (not reviews), one row per (case, origin, CN code)."""
    rows = []
    for path in sorted((EU_DIR / "details").glob("*.json")):
        case = json.loads(path.read_text(encoding="utf-8"))
        if case.get("caseType") != "Initial Investigation":
            continue
        kind = {"Anti-dumping": "AD", "Anti-subsidy": "CVD"}.get(case.get("category"), "SG")
        opened = pd.to_datetime(case.get("initDate"), unit="ms", errors="coerce")
        provisional, definitive = eu_date(case.get("provMeasures")), eu_date(case.get("defMeasures"))
        status = (case.get("measStatus") or "").strip().lower()
        if pd.notna(definitive):
            outcome = "duty"
        elif status.startswith("no measure"):
            outcome = "no_duty"
        else:
            outcome = "pending"
        codes = sorted({str(p.get("cn") or "")[:6] for p in case.get("caseProducts") or [] if p.get("cn")}) or [None]
        origins = [country_code(c["countryName"], by_name) for c in case.get("caseCountries") or []]
        for exporter in [o for o in origins if o] or []:
            for code in codes:
                rows.append({"case_id": f"EU-{case['caseNumber']}", "kind": kind, "market": "EU", "exporter": exporter,
                             "product": case.get("shortName"), "opened_on": opened, "prelim_on": provisional,
                             "final_measure_on": definitive, "revoked_on": pd.NaT, "outcome": outcome, "code": code})
    eu = pd.DataFrame(rows)
    print(f"EU TRON: {eu['case_id'].nunique()} initial investigations from {eu['opened_on'].min():%Y} to {eu['opened_on'].max():%Y}")
    return eu


def read_safeguards(by_name: dict[str, str]) -> pd.DataFrame:
    book = pd.read_excel(SAFEGUARD_FILE, sheet_name=None, dtype=str)
    master, products = book["SG-Master"], book["SG-Products"]
    cases = pd.DataFrame({"case_id": master["CASE_ID"].str.strip(), "product": master["PRODUCT"].str.strip(),
                          "market": [country_code(n, by_name) for n in master["SG_CTY_NAME"]]})
    cases["opened_on"] = first_date(master, ["WTO_INIT_DATE", "PET_DATE", "P_DATE", "F_DATE"])
    cases["prelim_on"] = first_date(master, ["P_SG_DATE"])
    cases["final_measure_on"] = first_date(master, ["F_SG_DATE"])
    cases["revoked_on"] = first_date(master, ["REVOKE_DATE", "TERM_DATE"])
    final_decision = master["F_DEC"].fillna("").str.strip().str.upper()
    decided = cases["opened_on"] + pd.to_timedelta(DECIDED_WITHIN_DAYS, unit="D") <= TTBD_LAST_UPDATE
    cases["outcome"] = np.select([cases["final_measure_on"].notna(), final_decision.eq("N") | decided], ["duty", "no_duty"], "pending")
    codes = pd.DataFrame({"case_id": products["CASE_ID"].str.strip(), "code": products["HS_CODE"].map(product_code)})
    cases = cases.merge(codes.dropna(), on="case_id", how="left")
    cases["kind"], cases["exporter"] = "SG", "ALL"
    print(f"TTBD safeguards: {cases['case_id'].nunique()} cases, {cases.loc[cases['market'].isna(), 'case_id'].nunique()} with an unknown market")
    return cases.dropna(subset=["market"])


def read_ttbd() -> pd.DataFrame:
    ttbd = pd.read_parquet(CASES_FILE)
    ttbd = ttbd[ttbd["source"].eq("ttbd")].copy()
    decided = ttbd["opened_on"] + pd.to_timedelta(DECIDED_WITHIN_DAYS, unit="D") <= TTBD_LAST_UPDATE
    ttbd["outcome"] = np.select([ttbd["final_measure_on"].notna(), decided], ["duty", "no_duty"], "pending")
    ttbd["prelim_on"] = pd.NaT
    return ttbd


# ---------------------------------------------------------------- merge

def same_cases(base: pd.DataFrame, other: pd.DataFrame) -> pd.DataFrame:
    """Pairs (base case, other case) with the same market, origin and kind, opened within SAME_CASE_DAYS."""
    left = base.drop_duplicates("case_id")[["case_id", "market", "exporter", "kind", "opened_on"]]
    right = other.drop_duplicates("case_id")[["case_id", "market", "exporter", "kind", "opened_on"]]
    pairs = left.merge(right, on=["market", "exporter", "kind"], suffixes=("", "_other"))
    pairs = pairs[(pairs["opened_on"] - pairs["opened_on_other"]).abs().dt.days <= SAME_CASE_DAYS]
    # The closest opening wins when several match.
    pairs["gap"] = (pairs["opened_on"] - pairs["opened_on_other"]).abs()
    return pairs.sort_values("gap").drop_duplicates("case_id").drop_duplicates("case_id_other")


def fill_outcomes(base: pd.DataFrame, other: pd.DataFrame, source: str) -> pd.DataFrame:
    """Where base and other are the same case: a decided outcome replaces a missing or pending one, and
    other's dates fill base's missing ones. Returns base and other's unmatched cases (added)."""
    pairs = same_cases(base, other)
    facts = other.drop_duplicates("case_id").set_index("case_id")
    lookup = pairs.set_index("case_id")["case_id_other"]
    matched = base["case_id"].map(lookup)
    has = matched.notna()
    other_outcome = matched.map(facts["outcome"])
    # TTBD's "no final measure" after 2 years is a guess; the WTO or EU record is the decision.
    replace = has & other_outcome.ne("pending") & base["final_measure_on"].isna()
    changed = (replace & base["outcome"].ne(other_outcome)).groupby(base["case_id"]).any().sum()
    base.loc[replace, "outcome"] = other_outcome[replace]
    for column in ("final_measure_on", "prelim_on", "revoked_on"):
        if column in facts:
            base.loc[has, column] = base.loc[has, column].fillna(matched[has].map(facts[column]))
    base.loc[has, "outcome_source"] = base.loc[has, "outcome_source"].fillna(source)
    added = other[~other["case_id"].isin(pairs["case_id_other"])].copy()
    added["outcome_source"] = source
    print(f"{source}: {pairs.shape[0]:,} cases matched, outcome changed for {changed:,}, {added['case_id'].nunique():,} cases added "
          f"(by year: {added.drop_duplicates('case_id')['opened_on'].dt.year.value_counts().sort_index().tail(6).to_dict()})")
    return pd.concat([base, added], ignore_index=True)


def build() -> pd.DataFrame:
    by_name = read_country_names() | COUNTRY_ALIASES
    concordance = HsConcordance(read_hs2012_codes())
    ttbd = read_ttbd()
    ttbd["outcome_source"] = np.where(ttbd["final_measure_on"].notna(), "ttbd", None)
    wto = map_products(expand_exporters(read_wto(by_name)), concordance)
    eu = map_products(expand_exporters(read_eu(by_name)), concordance)
    safeguards = map_products(read_safeguards(by_name), concordance)
    safeguards["outcome_source"] = "ttbd"
    cases = fill_outcomes(ttbd, wto, "wto")
    cases = fill_outcomes(cases, eu, "eu_tron")
    cases = pd.concat([cases, safeguards], ignore_index=True)
    cases["year"] = cases["opened_on"].dt.year.astype(int)
    cases["outcome_source"] = cases["outcome_source"].fillna("ttbd_no_final_measure")
    columns = ["case_id", "kind", "market", "exporter", "hs6", "opened_on", "year", "prelim_on", "final_measure_on", "revoked_on",
               "outcome", "outcome_source", "product"]
    cases = cases.dropna(subset=["hs6"]).drop_duplicates(["case_id", "market", "exporter", "hs6"])[columns]
    return cases.sort_values(["opened_on", "case_id"]).reset_index(drop=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("step", choices=["download", "build"])
    args = parser.parse_args()
    if args.step == "download":
        download_wto()
        download_eu()
        return
    cases = build()
    cases.to_parquet(HARSHNESS_CASES_FILE, index=False)
    per_case = cases.drop_duplicates("case_id")
    print(f"wrote {HARSHNESS_CASES_FILE}: {len(cases):,} rows, {len(per_case):,} cases")
    table = per_case[per_case["year"] >= 2012].pivot_table(index="year", columns="outcome", values="case_id", aggfunc="count", fill_value=0)
    print(table.to_string())
    print(per_case.groupby(["kind", "outcome_source"]).size().unstack(fill_value=0).to_string())


if __name__ == "__main__":
    main()
