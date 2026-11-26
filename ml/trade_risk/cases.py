"""Trade defence cases, every product mapped to an HS 2012 six-digit code (the edition BACI uses).

    uv run python -m trade_risk.cases              # writes data/interim/trade_risk/cases.parquet
    uv run python -m trade_risk.cases --download   # first fetches new Federal Register notices

Sources:
- World Bank Temporary Trade Barriers Database (TTBD): anti-dumping (AD) and countervailing (CVD)
  cases of ~45 markets to the end of 2024. Global safeguards are left out: they target every
  exporter at once, not one exporting country.
- US Federal Register initiation notices from 2025 on (TTBD stops at 2024).

One row per (case, market, exporter, HS 6). A case's product codes are written in the HS edition in
force when it opened, often at 8 or 10 digits; they are cut to 6 digits and mapped to HS 2012 with
the WITS concordance tables, so a 2023 plywood case on 4412.33 lands on BACI's 4412.32.
"""

import argparse
import json
import re
import time
import urllib.parse
import urllib.request
import zipfile

import numpy as np
import pandas as pd

from trade_risk.common import (
    BACI_ZIP,
    CASE_CODE_FIXES,
    CASES_FILE,
    CONCORDANCE_DIR,
    EU27,
    FEDERAL_REGISTER_DIR,
    INTERIM_DIR,
    TTBD_DIR,
)

KIND_BY_FOLDER = {"Global antidumping measures": "AD", "Global countervailing measures": "CVD"}
MARKET_BY_SHEET_CODE = {"EUN": "EU", "SAU": "GCC"}
EDITION_START_YEAR = {"H0": 1988, "H1": 1996, "H2": 2002, "H3": 2007, "H4": 2012, "H5": 2017, "H6": 2022}
EDITIONS = list(EDITION_START_YEAR)
FEDERAL_REGISTER_API = "https://www.federalregister.gov/api/v1/documents.json"
FEDERAL_REGISTER_SINCE = "2023-01-01"  # overlaps TTBD by two years, to check its completeness
INITIATION_TITLE = re.compile(r"Initiation of (Less[- ]Than[- ]Fair[- ]Value|Countervailing Duty) Investigations?\s*$", re.I)
HTS_CODE = re.compile(r"\b(\d{4})\.(\d{2})(?:\.\d{2,4})?\b")
SAME_CASE_DAYS = 60  # a Federal Register notice and a TTBD case this close, same kind, exporter and a product: one case
NOTES_CODE = re.compile(r"\b\d{4}(?:[.\s]?\d{2}){1,3}\b")
USER_AGENT = {"User-Agent": "exportmate-research"}

COUNTRY_ALIASES = {
    "argentine republic": "ARG", "bolivarian republic of venezuela": "VEN", "bosnia-herzegovina": "BIH",
    "brunei": "BRN", "burma": "MMR", "china": "CHN", "czech republic": "CZE", "czechia": "CZE",
    "dominican republic": "DOM", "hellenic republic": "GRC", "hong kong": "HKG", "iran": "IRN", "ivory coast": "CIV",
    "korea": "KOR", "south korea": "KOR", "kyrgyz republic": "KGZ", "laos": "LAO",
    "lao people's democratic republic": "LAO", "macedonia": "MKD", "north macedonia": "MKD", "mexico": "MEX",
    "united mexican states": "MEX", "moldova": "MDA", "russia": "RUS", "russian federation": "RUS",
    "slovak republic": "SVK", "taiwan": "TWN", "trinidad-tobago": "TTO", "turkey": "TUR", "türkiye": "TUR",
    "turkiye": "TUR", "united kingdom": "GBR", "united states": "USA", "vietnam": "VNM", "viet nam": "VNM",
}
# Names with "and" inside, protected before a title's country list is split on "and".
COMPOUND_COUNTRIES = {"Bosnia and Herzegovina": "Bosnia-Herzegovina", "Trinidad and Tobago": "Trinidad-Tobago",
                      "Antigua and Barbuda": "Antigua-Barbuda", "Saint Kitts and Nevis": "Saint Kitts-Nevis"}
COUNTRY_PREFIXES = (
    "the ", "people's republic of ", "socialist republic of ", "democratic socialist republic of ", "republic of ",
    "kingdom of ", "federative republic of ", "federal republic of ", "arab republic of ", "islamic republic of ",
    "sultanate of ", "state of ", "grand duchy of ", "independent state of ", "commonwealth of ",
)


class HsConcordance:
    """Maps a six-digit code of any HS edition (1988 to 2022) to the HS 2012 codes it covers."""

    def __init__(self, hs2012_codes: set[str]):
        self.hs2012_codes = hs2012_codes
        self.to_hs2012 = {"H4": {code: {code} for code in hs2012_codes}}
        for edition in ("H5", "H6"):  # published newer -> 2012
            table = read_concordance(f"Concordance_{edition}_to_H4.zip")
            self.to_hs2012[edition] = table.groupby(table.columns[0])[table.columns[1]].agg(set).to_dict()
        for edition in ("H0", "H1", "H2", "H3"):  # published 2012 -> older: invert
            table = read_concordance(f"Concordance_H4_to_{edition}.zip")
            self.to_hs2012[edition] = table.groupby(table.columns[1])[table.columns[0]].agg(set).to_dict()

    def editions_to_try(self, year: int) -> list[str]:
        in_force = max(e for e in EDITIONS if EDITION_START_YEAR[e] <= max(year, 1988))
        position = EDITIONS.index(in_force)
        # The edition in force first, then the nearest ones (older first: countries adopt late).
        return sorted(EDITIONS, key=lambda e: (abs(EDITIONS.index(e) - position), EDITIONS.index(e) > position))

    def map_code(self, code: str, year: int) -> set[str]:
        if len(code) == 6:
            for edition in self.editions_to_try(year):
                if code in self.to_hs2012[edition]:
                    return self.to_hs2012[edition][code]
            return set()
        # A four-digit heading: every HS 2012 product under it.
        found = {c for c in self.hs2012_codes if c.startswith(code)}
        if found:
            return found
        for edition in self.editions_to_try(year):
            found = {h for c, targets in self.to_hs2012[edition].items() if c.startswith(code) for h in targets}
            if found:
                return found
        return set()


def read_concordance(name: str) -> pd.DataFrame:
    archive = zipfile.ZipFile(CONCORDANCE_DIR / name)
    csv_name = next(n for n in archive.namelist() if n.upper().endswith(".CSV"))
    table = pd.read_csv(archive.open(csv_name), dtype=str, encoding="latin-1")
    pairs = table.iloc[:, [0, 2]].dropna()
    return pairs.apply(lambda column: column.str.strip().str.zfill(6))


def read_hs2012_codes() -> set[str]:
    archive = zipfile.ZipFile(BACI_ZIP)
    name = next(n for n in archive.namelist() if n.startswith("product_codes_HS12"))
    return set(pd.read_csv(archive.open(name), dtype=str)["code"].str.zfill(6))


def read_country_names() -> dict[str, str]:
    archive = zipfile.ZipFile(BACI_ZIP)
    name = next(n for n in archive.namelist() if n.startswith("country_codes"))
    table = pd.read_csv(archive.open(name)).dropna(subset=["country_iso3"])
    return {normalise_country(n): iso for n, iso in zip(table["country_name"], table["country_iso3"])}


def normalise_country(name: str) -> str:
    text = re.sub(r"\s+", " ", str(name).strip().lower().replace("’", "'"))
    changed = True
    while changed:
        changed = False
        for prefix in COUNTRY_PREFIXES:
            if text.startswith(prefix):
                text, changed = text[len(prefix):], True
    return text


def product_code(raw: str) -> str | None:
    """Six digits, or four for a heading; None when unusable. Repairs zeros Excel dropped."""
    text = re.sub(r"\.0$", "", str(raw).strip())
    dotted = re.fullmatch(r"(\d{3,4})\.(\d+)", text)
    if dotted:
        digits = dotted.group(1).zfill(4) + dotted.group(2).ljust(2, "0")
    else:
        digits = re.sub(r"\D", "", text)
        if len(digits) in (3, 5, 7, 9):
            digits = "0" + digits
    if len(digits) >= 6:
        return digits[:6]
    if len(digits) == 4:
        return digits
    return None


def first_date(frame: pd.DataFrame, columns: list[str]) -> pd.Series:
    present = [c for c in columns if c in frame]
    if not present:
        return pd.Series(pd.NaT, index=frame.index)
    dates = pd.concat([pd.to_datetime(frame[c], errors="coerce", format="mixed") for c in present], axis=1)
    return dates.min(axis=1)


def first_number(frame: pd.DataFrame, columns: list[str]) -> pd.Series:
    result = pd.Series(float("nan"), index=frame.index)
    for column in columns:
        if column in frame:
            result = result.fillna(pd.to_numeric(frame[column], errors="coerce"))
    return result


def ttbd_sheet_cases(master: pd.DataFrame, products: pd.DataFrame | None, kind: str, market: str) -> pd.DataFrame:
    cases = pd.DataFrame({
        "case_id": master["CASE_ID"].str.strip(),
        "kind": kind,
        "market": market,
        "exporter": master["INV_CTY_CODE"].astype(str).str.strip().str.upper(),
        "product": master["PRODUCT"].astype(str).str.strip(),
        "notes": master.get("NOTES", pd.Series("", index=master.index)).astype(str),
    })
    opened = pd.to_datetime(master["INIT_DATE"], errors="coerce", format="mixed")
    other_dates = [c for c in master.columns if c.endswith("_DATE") and c != "REVOKE_DATE"]
    cases["opened_on"] = opened.fillna(first_date(master, other_dates))
    cases["final_measure_on"] = first_date(master, [f"F_{kind}_DATE", "F_DATE"])
    cases["revoked_on"] = first_date(master, ["REVOKE_DATE"])
    # TTBD writes "IF" when the duty is still in force (at its last update, late 2024), "MI" or "."
    # when the revocation is unknown or doesn't apply: only "IF" says the duty never ended.
    revoke_text = master.get("REVOKE_DATE", pd.Series("", index=master.index)).astype(str).str.strip().str.upper()
    cases["measure_status"] = np.select(
        [cases["final_measure_on"].isna(), revoke_text.eq("IF"), cases["revoked_on"].notna()],
        ["no final measure", "in force", "revoked"], "end unknown")
    cases["duty_pct"] = first_number(master, [f"F_{kind}_DUTY", "WTO_F_MARGIN_MAX", "F_MARGIN"])
    if products is not None:
        codes = pd.DataFrame({"case_id": products["CASE_ID"].str.strip(), "raw_code": products["HS_CODE"].astype(str)})
    else:  # the "other markets" sheets list codes only in their notes
        found = [(cid, code) for cid, note in zip(cases["case_id"], cases["notes"]) for code in NOTES_CODE.findall(note)]
        codes = pd.DataFrame(found, columns=["case_id", "raw_code"])
    codes["code"] = codes["raw_code"].map(product_code)
    return cases.merge(codes.dropna(subset=["code"])[["case_id", "code"]], on="case_id", how="left")


def read_ttbd() -> pd.DataFrame:
    parts = []
    for folder, kind in KIND_BY_FOLDER.items():
        for path in sorted((TTBD_DIR / folder).glob("*.xls*")):
            book = pd.read_excel(path, sheet_name=None, dtype=str)
            for sheet_name, master in book.items():
                if not sheet_name.endswith("-Master"):
                    continue
                prefix = sheet_name[: -len("Master")]
                sheet_code = sheet_name.split("-")[1]
                market = MARKET_BY_SHEET_CODE.get(sheet_code, sheet_code)
                parts.append(ttbd_sheet_cases(master, book.get(prefix + "Products"), kind, market))
    cases = pd.concat(parts, ignore_index=True)
    brexit = cases["notes"].str.contains("adopted from the EU", case=False, na=False)
    print(f"TTBD: {cases['case_id'].nunique()} cases; dropped {cases.loc[brexit, 'case_id'].nunique()} UK cases carried over from the EU at Brexit")
    cases = cases[~brexit]
    cases["source"] = "ttbd"
    return cases.drop(columns="notes")


def download_federal_register() -> None:
    FEDERAL_REGISTER_DIR.mkdir(parents=True, exist_ok=True)
    notices, page = [], 1
    while True:
        params = [
            ("per_page", "1000"), ("page", str(page)), ("order", "oldest"),
            ("conditions[agencies][]", "international-trade-administration"), ("conditions[type][]", "NOTICE"),
            ("conditions[publication_date][gte]", FEDERAL_REGISTER_SINCE), ("conditions[term]", "initiation"),
            ("fields[]", "title"), ("fields[]", "publication_date"), ("fields[]", "raw_text_url"), ("fields[]", "document_number"),
        ]
        request = urllib.request.Request(f"{FEDERAL_REGISTER_API}?{urllib.parse.urlencode(params)}", headers=USER_AGENT)
        body = json.load(urllib.request.urlopen(request, timeout=90))
        notices += body.get("results", [])
        if page >= (body.get("total_pages") or 1):
            break
        page += 1
        time.sleep(1)
    initiations = [n for n in notices if INITIATION_TITLE.search(n["title"].strip())]
    (FEDERAL_REGISTER_DIR / "initiation_notices.json").write_text(json.dumps(initiations, indent=1), encoding="utf-8")
    for notice in initiations:
        path = FEDERAL_REGISTER_DIR / f"{notice['document_number']}.txt"
        if path.exists() or not notice.get("raw_text_url"):
            continue
        for attempt in range(4):
            try:
                request = urllib.request.Request(notice["raw_text_url"], headers=USER_AGENT)
                path.write_bytes(urllib.request.urlopen(request, timeout=90).read())
                break
            except OSError:
                time.sleep(5 * (attempt + 1))
        time.sleep(0.7)
    missing = [n["document_number"] for n in initiations if not (FEDERAL_REGISTER_DIR / f"{n['document_number']}.txt").exists()]
    print(f"Federal Register: {len(initiations)} initiation notices since {FEDERAL_REGISTER_SINCE}; texts missing: {missing}")


def scope_codes(text: str, hs2022_codes: set[str]) -> list[str]:
    """HS 2022 six-digit codes the notice names (its scope, including "may also enter under", as TTBD lists)."""
    return sorted({heading + subheading for heading, subheading in HTS_CODE.findall(text) if heading + subheading in hs2022_codes})


def read_federal_register(hs2022_codes: set[str]) -> pd.DataFrame:
    country_by_name = read_country_names() | COUNTRY_ALIASES
    notices = json.loads((FEDERAL_REGISTER_DIR / "initiation_notices.json").read_text(encoding="utf-8"))
    rows, unknown = [], set()
    for notice in notices:
        path = FEDERAL_REGISTER_DIR / f"{notice['document_number']}.txt"
        if not path.exists():
            continue
        title = re.sub(r"\s+", " ", notice["title"].strip())
        before_colon = title.split(":")[0]
        match = re.match(r"^(.*)\s[Ff]rom\s(.*)$", before_colon)
        if not match:
            continue
        product, country_text = match.groups()
        kind = "AD" if "fair" in title.lower() else "CVD"
        for compound, protected in COMPOUND_COUNTRIES.items():
            country_text = country_text.replace(compound, protected)
        names = [n for n in re.split(r",\s*(?:and\s+)?|\s+and\s+", country_text) if n.strip()]
        exporters = []
        for name in names:
            code = country_by_name.get(normalise_country(name))
            if code is None:
                unknown.add(name)
            else:
                exporters.append(code)
        codes = scope_codes(path.read_text(encoding="utf-8", errors="replace"), hs2022_codes)
        for exporter in exporters:
            for code in codes or [None]:
                rows.append({
                    "case_id": f"USA-{kind}-FR{notice['document_number']}-{exporter}", "kind": kind, "market": "USA",
                    "exporter": exporter, "product": product, "opened_on": pd.Timestamp(notice["publication_date"]),
                    "final_measure_on": pd.NaT, "revoked_on": pd.NaT, "measure_status": "no final measure",
                    "duty_pct": float("nan"), "code": code,
                    "source": "federal_register",
                })
    if unknown:
        print("Federal Register: unknown country names:", sorted(unknown))
    return pd.DataFrame(rows)


def expand_exporters(cases: pd.DataFrame) -> pd.DataFrame:
    cases["exporter"] = cases["exporter"].replace(CASE_CODE_FIXES)
    whole_eu = cases["exporter"] == "EU"
    members = cases[whole_eu].merge(pd.DataFrame({"member": sorted(EU27)}), how="cross")
    members["exporter"] = members.pop("member")
    return pd.concat([cases[~whole_eu], members], ignore_index=True)


def map_products(cases: pd.DataFrame, concordance: HsConcordance) -> pd.DataFrame:
    cases = cases.dropna(subset=["code", "opened_on"]).copy()
    cases["year"] = cases["opened_on"].dt.year.astype(int)
    pairs = cases[["code", "year"]].drop_duplicates()
    pairs["hs6"] = [sorted(concordance.map_code(c, y)) for c, y in zip(pairs["code"], pairs["year"])]
    cases = cases.merge(pairs, on=["code", "year"]).explode("hs6").dropna(subset=["hs6"])
    return cases


def compare_with_ttbd(ttbd: pd.DataFrame, federal: pd.DataFrame) -> None:
    """Both sources cover US cases from 2023 to 2024: how many (kind, exporter, HS 6) rows each has."""
    keys = ["kind", "exporter", "hs6"]
    for start, end in [("2023-01-01", "2023-12-31"), ("2024-01-01", "2024-06-30"), ("2024-07-01", "2024-12-31")]:
        in_window = lambda frame: frame[(frame["market"] == "USA") & frame["opened_on"].between(start, end)]
        a, b = set(map(tuple, in_window(ttbd)[keys].values)), set(map(tuple, in_window(federal)[keys].values))
        print(f"  US {start[:7]} to {end[:7]}: TTBD {len(a)} rows, Federal Register {len(b)}, both {len(a & b)}"
              f" (FR finds {len(a & b) / max(len(a), 1):.0%} of TTBD's, TTBD {len(a & b) / max(len(b), 1):.0%} of FR's)")


def merge_sources(ttbd: pd.DataFrame, federal: pd.DataFrame) -> pd.DataFrame:
    """TTBD, plus the US cases from the Federal Register that TTBD lacks (it misses some of 2023 and
    stops around September 2024). A notice is TTBD's case when TTBD has a case of the same kind against
    the same exporter, opened within SAME_CASE_DAYS, sharing a product: then TTBD's row is kept (it has
    the outcome and duty) and the notice never widens it."""
    us_ttbd = ttbd[ttbd["market"] == "USA"]
    ttbd_cases = us_ttbd.groupby("case_id").agg(kind=("kind", "first"), exporter=("exporter", "first"),
                                                opened_on=("opened_on", "first"), hs6=("hs6", set))
    notices = federal.groupby("case_id").agg(kind=("kind", "first"), exporter=("exporter", "first"),
                                             opened_on=("opened_on", "first"), hs6=("hs6", set))
    candidates = notices.reset_index().merge(ttbd_cases.reset_index(), on=["kind", "exporter"], suffixes=("", "_ttbd"))
    close = (candidates["opened_on"] - candidates["opened_on_ttbd"]).abs().dt.days <= SAME_CASE_DAYS
    shared = [bool(a & b) for a, b in zip(candidates["hs6"], candidates["hs6_ttbd"])]
    known = set(candidates.loc[close & pd.Series(shared, index=candidates.index), "case_id"])
    new_notices = federal[~federal["case_id"].isin(known)]
    print(f"Federal Register: {notices.shape[0]} US cases, {len(known)} already in TTBD, "
          f"{new_notices['case_id'].nunique()} added ({new_notices.groupby('year')['case_id'].nunique().to_dict()})")
    return pd.concat([ttbd, new_notices], ignore_index=True).drop_duplicates(["case_id", "market", "exporter", "hs6"])


def build_cases(download: bool) -> pd.DataFrame:
    if download:
        download_federal_register()
    concordance = HsConcordance(read_hs2012_codes())
    ttbd = expand_exporters(read_ttbd())
    raw_codes = ttbd.dropna(subset=["code"])
    federal = expand_exporters(read_federal_register(set(concordance.to_hs2012["H6"])))
    ttbd, federal = map_products(ttbd, concordance), map_products(federal, concordance)
    print("Federal Register against TTBD:")
    compare_with_ttbd(ttbd, federal)
    cases = merge_sources(ttbd, federal)
    naive = raw_codes[raw_codes["code"].str.len() == 6]["code"].isin(concordance.hs2012_codes).mean()
    print(f"product codes usable as HS 2012 before mapping: {naive:.1%}; case rows after mapping: {len(cases):,}")
    columns = ["case_id", "kind", "market", "exporter", "hs6", "opened_on", "year", "final_measure_on", "revoked_on", "measure_status",
               "duty_pct", "product", "source"]
    return cases[columns].sort_values(["opened_on", "case_id"]).reset_index(drop=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--download", action="store_true", help="fetch new Federal Register notices first")
    args = parser.parse_args()
    cases = build_cases(args.download)
    INTERIM_DIR.mkdir(parents=True, exist_ok=True)
    cases.to_parquet(CASES_FILE, index=False)
    by_year = cases[cases["year"] >= 2018].groupby(["year", "source"])["case_id"].nunique().unstack(fill_value=0)
    print(f"wrote {CASES_FILE}: {len(cases):,} rows, {cases['case_id'].nunique():,} cases, {cases['market'].nunique()} markets")
    print("cases by year and source:\n" + by_year.to_string())


if __name__ == "__main__":
    main()
