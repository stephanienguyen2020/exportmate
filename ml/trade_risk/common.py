"""Paths and constants shared by the trade defence risk scripts."""

import os
from pathlib import Path

ML_DIR = Path(__file__).resolve().parents[1]
# Data lives outside git; ML_DATA_DIR points at it when the code runs from another checkout.
DATA_DIR = Path(os.environ.get("ML_DATA_DIR", ML_DIR / "data"))
RAW_DIR = DATA_DIR / "raw"
INTERIM_DIR = DATA_DIR / "interim" / "trade_risk"
MODELS_DIR = Path(os.environ.get("ML_MODELS_DIR", ML_DIR / "models")) / "trade_risk"

BACI_ZIP = RAW_DIR / "baci" / "BACI_HS12_V202601.zip"
TTBD_DIR = RAW_DIR / "ttbd"
CONCORDANCE_DIR = RAW_DIR / "concordance"
FEDERAL_REGISTER_DIR = RAW_DIR / "federal_register"

CASES_FILE = INTERIM_DIR / "cases.parquet"
TRADE_FLOWS_FILE = INTERIM_DIR / "trade_flows.parquet"
EXPORTER_TOTALS_FILE = INTERIM_DIR / "exporter_totals.parquet"
FEATURES_FILE = INTERIM_DIR / "features.parquet"

# Customs unions open cases as one market: members' imports are summed, trade inside the union dropped.
EU27 = frozenset(
    "AUT BEL BGR HRV CYP CZE DNK EST FIN FRA DEU GRC HUN IRL ITA LVA LTU LUX MLT NLD POL PRT ROU SVK SVN ESP SWE".split()
)
CUSTOMS_UNIONS = {
    "EU": EU27,
    "EAEU": frozenset("RUS KAZ BLR ARM KGZ".split()),
    "GCC": frozenset("SAU ARE KWT QAT BHR OMN".split()),
}

# BACI calls Taiwan "S19" (Other Asia, nes); the case lists and the app call it TWN.
BACI_CODE_FIXES = {"S19": "TWN"}
# Old or mistyped exporter codes in the case lists.
CASE_CODE_FIXES = {"FRG": "DEU", "POR": "PRT", "NWY": "NOR", "JDN": "JOR", "ROM": "ROU", "EUN": "EU"}

FIRST_TRADE_YEAR = 2012
LAST_TRADE_YEAR = 2024
MIN_FLOW_USD = 1_000_000
