"""Annual imports by market, exporter and HS 2012 product, from CEPII BACI.

    uv run python -m trade_risk.trade_flows   # needs cases.parquet (for the list of markets)

Writes two tables:
- trade_flows.parquet: year, market, exporter, hs6, value_usd, tonnes, for the markets in the case
  list. Customs unions (EU, EAEU, GCC) are one market: members' imports summed, trade inside the
  union left out.
- exporter_totals.parquet: year, exporter, hs6, world_value_usd: what each country exported of each
  product to every destination, for the exporter features.
"""

import zipfile

import pandas as pd
import pyarrow.csv as pcsv

from trade_risk.common import (
    BACI_CODE_FIXES,
    BACI_ZIP,
    CASES_FILE,
    CUSTOMS_UNIONS,
    EXPORTER_TOTALS_FILE,
    TRADE_FLOWS_FILE,
)


def read_country_codes(archive: zipfile.ZipFile) -> dict[int, str]:
    name = next(n for n in archive.namelist() if n.startswith("country_codes"))
    codes = pd.read_csv(archive.open(name)).dropna(subset=["country_iso3"])
    return {code: BACI_CODE_FIXES.get(iso, iso) for code, iso in zip(codes["country_code"], codes["country_iso3"])}


def read_year(archive: zipfile.ZipFile, name: str, iso: dict[int, str]) -> pd.DataFrame:
    table = pcsv.read_csv(
        archive.open(name),
        convert_options=pcsv.ConvertOptions(column_types={"k": "string", "v": "float64", "q": "float64"}),
    ).to_pandas()
    table["exporter"] = table["i"].map(iso)
    table["importer"] = table["j"].map(iso)
    table["hs6"] = table["k"].str.zfill(6)
    table["value_usd"] = table["v"] * 1000  # BACI values are in thousands of US dollars
    return table.dropna(subset=["exporter", "importer"])[["t", "exporter", "importer", "hs6", "value_usd", "q"]]


def to_markets(year_table: pd.DataFrame, markets: set[str]) -> pd.DataFrame:
    market_of = {member: union for union, members in CUSTOMS_UNIONS.items() for member in members}
    table = year_table.assign(market=year_table["importer"].map(market_of).fillna(year_table["importer"]))
    inside_union = table["exporter"].map(market_of).eq(table["market"])
    table = table[~inside_union & table["market"].isin(markets)]
    grouped = table.groupby(["t", "market", "exporter", "hs6"], as_index=False).agg(
        value_usd=("value_usd", "sum"), tonnes=("q", "sum"), tonnes_reported=("q", "count"))
    grouped.loc[grouped["tonnes_reported"] == 0, "tonnes"] = float("nan")  # no member reported a quantity
    return grouped.drop(columns="tonnes_reported")


def main() -> None:
    markets = set(pd.read_parquet(CASES_FILE, columns=["market"])["market"])
    archive = zipfile.ZipFile(BACI_ZIP)
    iso = read_country_codes(archive)
    flows, totals = [], []
    for name in sorted(n for n in archive.namelist() if n.startswith("BACI_HS12_Y")):
        year_table = read_year(archive, name, iso)
        totals.append(year_table.groupby(["t", "exporter", "hs6"], as_index=False)["value_usd"].sum()
                      .rename(columns={"value_usd": "world_value_usd"}))
        flows.append(to_markets(year_table, markets))
        print(f"{name}: {len(year_table):,} flows, {len(flows[-1]):,} into the {len(markets)} markets", flush=True)
    trade = pd.concat(flows, ignore_index=True).rename(columns={"t": "year"})
    trade["year"] = trade["year"].astype("int16")
    trade.to_parquet(TRADE_FLOWS_FILE, index=False)
    exporter_totals = pd.concat(totals, ignore_index=True).rename(columns={"t": "year"})
    exporter_totals.to_parquet(EXPORTER_TOTALS_FILE, index=False)
    print(f"wrote {TRADE_FLOWS_FILE} ({len(trade):,} rows) and {EXPORTER_TOTALS_FILE} ({len(exporter_totals):,} rows)")
    missing = markets - set(trade["market"])
    if missing:
        print("markets with no BACI imports:", sorted(missing))


if __name__ == "__main__":
    main()
