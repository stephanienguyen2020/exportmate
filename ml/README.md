# ML (offline models)

Offline models for ExportMate.

The **trade defence risk model** (`trade_risk/`): will a market open an anti-dumping or
anti-subsidy case against an exporting country on a product next year?

- Design (use case, data, features, training, how it is served): [`docs/TRADE_DEFENCE_RISK_MODEL.md`](docs/TRADE_DEFENCE_RISK_MODEL.md)
- What each test found: [`docs/TRADE_DEFENCE_RISK_RESULTS.md`](docs/TRADE_DEFENCE_RISK_RESULTS.md)

## Layout

```
ml/
  pyproject.toml # Python dependencies (uv)
  docs/          # the model's design and test results
  trade_risk/    # the trade defence risk model: data preparation, training, explanations
  data/          # git-ignored: downloaded and prepared data
    raw/         # files exactly as downloaded, one folder per source
    interim/     # prepared tables (parquet)
  models/        # git-ignored: trained models and their reports, one folder per date
```

`data/` and `models/` are never committed. Each person downloads the files themselves.
Check each source's terms before training on it.

## Trade defence risk model

Setup: `cd ml && uv sync`. The data folder can live elsewhere: `ML_DATA_DIR=/path/to/ml/data`.

| Source | Folder in `data/raw/` | Download | Terms |
| --- | --- | --- | --- |
| CEPII BACI, HS 2012, version 202601: yearly imports by importer, exporter, HS 6, 2012–2024 | `baci/BACI_HS12_V202601.zip` | https://www.cepii.fr/DATA_DOWNLOAD/baci/data/BACI_HS12_V202601.zip (1.3 GB) | Etalab Open Licence 2.0: any use, cite "CEPII BACI" |
| World Bank Temporary Trade Barriers Database: anti-dumping and countervailing cases, ~45 markets, to 2024 | `ttbd/` (unzipped) | https://thedocs.worldbank.org/en/doc/1b03ee05a4a6d2374c126196ddf0a128-0430012025/related/All-underlaying-data.zip | No licence stated; public research data, cite Bown, Cieszkowsky, Erbahar, Signoret (2020) |
| US Federal Register: initiation notices of US cases, 2023 on (fills TTBD's gaps and goes past 2024) | `federal_register/` | `uv run python -m trade_risk.cases --download` | Public domain |
| WITS HS concordance tables (each HS edition to HS 2012) | `concordance/` | `https://wits.worldbank.org/data/public/concordance/Concordance_{H6_to_H4,H5_to_H4,H4_to_H3,H4_to_H2,H4_to_H1,H4_to_H0}.zip` | World Bank data, public |

Run in order (each step writes to `data/interim/trade_risk/` or `models/trade_risk/<date>/`):

```sh
uv run python -m trade_risk.cases          # cases, every product as an HS 2012 code (--download: new Federal Register notices)
uv run python -m trade_risk.trade_flows    # BACI imports into the case markets, exporters' world totals (~25 min)
uv run python -m trade_risk.features       # one row per (market, exporter, HS 6, year), the label: a case the next year
uv run python -m trade_risk.train tune     # random search per model, validated on 2016, 2017 and 2018 (~1 h)
uv run python -m trade_risk.train compare  # walk-forward test 2019-2023 for every model, average and ablation (~35 min)
uv run python -m trade_risk.final_model    # the chosen model (the three boosted models averaged): checks, train on 2013-2023, score 2024, check 2025 (US)
```

## Moving to GCP later

Training runs on a laptop first. Later, the raw files go to a Cloud Storage
bucket and training runs on Vertex AI (custom training job), reading from
that bucket instead of `data/`.
