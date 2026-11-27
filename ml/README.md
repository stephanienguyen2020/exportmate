# ML (offline models)

Offline models for ExportMate, and the job that scores the app's trade pairs.

The **trade defence risk model** (`trade_risk/`): will a market open an anti-dumping or
anti-subsidy case against an exporting country on a product next year?

- Design (use case, data, features, training, how it is served): [`docs/TRADE_DEFENCE_RISK_MODEL.md`](docs/TRADE_DEFENCE_RISK_MODEL.md)
- What each test found: [`docs/TRADE_DEFENCE_RISK_RESULTS.md`](docs/TRADE_DEFENCE_RISK_RESULTS.md)

The **harshness model** (`trade_risk/harshness*.py`, severity model v2): once a case is opened, how
badly will it cut imports of that product from that origin into that market? Offline only so far.

- Design: [`docs/HARSHNESS_MODEL.md`](docs/HARSHNESS_MODEL.md)
- What each test found: [`docs/HARSHNESS_RESULTS.md`](docs/HARSHNESS_RESULTS.md)

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
  Dockerfile     # the Order features job's image (code only)
  deploy.sh      # build it on Cloud Build and roll it out to the Cloud Run job
  upload.sh      # copy data/ and models/ to the ML bucket
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
| UN Comtrade monthly imports (for scoring recent months, not training) | `comtrade/` | API key in `ml/.env` (`COMTRADE_API_KEY`) | Internal use; credit "Source: UN Comtrade"; one account, 500 calls a day |

Run in order (each step writes to `data/interim/trade_risk/` or `models/trade_risk/<date>/`):

```sh
uv run python -m trade_risk.cases          # cases, every product as an HS 2012 code (--download: new Federal Register notices)
uv run python -m trade_risk.trade_flows    # BACI imports into the case markets, exporters' world totals (~25 min)
uv run python -m trade_risk.features       # one row per (market, exporter, HS 6, year), the label: a case the next year
uv run python -m trade_risk.train tune     # random search per model, validated on 2016, 2017 and 2018 (~1 h)
uv run python -m trade_risk.train compare  # walk-forward test 2019-2023 for every model, average and ablation (~35 min)
uv run python -m trade_risk.final_model    # the chosen model (the three boosted models averaged): checks, train on 2013-2023, score 2024, check 2025 (US)
```

### Order features job (the app's scores)

`trade_risk/order_features.py` fills the app's Postgres tables (`import_figures`,
`trade_flow_features`, `trade_risk_scores`, `trade_cases`; created by the backend's migrations) and
scores each pair with the newest saved model (`trade_risk/scoring.py`, the folder in `models/`).
The pairs come from `order_trade_pairs`, which the backend keeps (one row per order).
It needs the prepared data above, the model, `DATABASE_URL` (the backend's, `postgresql://` or
`postgresql+psycopg://`) and `COMTRADE_API_KEY` (environment or `ml/.env`).

```sh
uv run python -m trade_risk.order_features --new                # orders' pairs with no score yet (the backend starts this)
uv run python -m trade_risk.order_features --pair US:VN:441231   # one pair: destination, exporting country, HS code
uv run python -m trade_risk.order_features                       # monthly: orders' pairs and pairs scored before, and the case list
uv run python -m trade_risk.order_features --rescore             # after a new model: score saved features again, no downloads
uv run python -m trade_risk.order_features --no-comtrade --pair … # BACI only
uv run pytest                                                    # unit tests
```

The backend starts it after saving orders with new pairs, and for a what-if pair with no score: locally set `TRADE_RISK_JOB_COMMAND="uv run
python -m trade_risk.order_features"` in `backend/.env` (it runs in `../ml`).

A pair costs about 5 Comtrade calls the first time (51 months, 12 a call) and 1 a month after (the
months not yet reported); the free key allows 500 a day. US imports have no reported weight on
Comtrade (its weights are estimated from one price per product), so their price and tonnage
features are left empty.

### On Google Cloud

The job runs as the Cloud Run job `exportmate-order-features` (`infra/terraform/trade_risk.tf`). Its
image holds only the code (`Dockerfile`); the data and the model are in the bucket
`exportmate-ml-dev`, mounted read-only at `/mnt/ml` (`ML_DATA_DIR`, `ML_MODELS_DIR`). The backend
starts it for new pairs (`TRADE_RISK_JOB`), and Cloud Scheduler runs it on the 1st of each month.

First time:

```sh
PROJECT_ID=skilful-scarab-511320-q9
# 1. The Comtrade key (from ml/.env), never in Terraform state. The job reads it, so the secret
#    gets its value before the job is created:
terraform -chdir=infra/terraform apply -target=google_secret_manager_secret.comtrade_api_key
printf %s "$COMTRADE_API_KEY" | gcloud secrets versions add trade-risk-comtrade-api-key --project $PROJECT_ID --data-file=-
terraform -chdir=infra/terraform apply
# 2. The data and the model (about 2.3 GB the first time; later only changed files):
PROJECT_ID=$PROJECT_ID ml/upload.sh
# 3. The image:
PROJECT_ID=$PROJECT_ID ml/deploy.sh
# 4. The case list into the app database, then score the orders' pairs:
gcloud run jobs execute exportmate-order-features --project $PROJECT_ID --region asia-southeast1 --args=--cases --wait
gcloud run jobs execute exportmate-order-features --project $PROJECT_ID --region asia-southeast1 --args=--new --wait
```

After preparing new data or training a new model, run `ml/upload.sh` again (the job picks the
newest model folder); after changing the code, `ml/deploy.sh`.

Training still runs on a laptop. Later it moves to Vertex AI (a custom training job reading the
same bucket instead of `data/`).

## Harshness model

Uses the trade risk model's prepared data (`cases`, `trade_flows` and `features` first) and two more
sources:

| Source | Folder in `data/raw/` | Download | Terms |
| --- | --- | --- | --- |
| WTO Trade Remedies Data Portal: anti-dumping and anti-subsidy investigations, HS codes, conclusions, dates duties came into force | `wto_trade_remedies/` | `uv run python -m trade_risk.harshness_cases download` | WTO public data; cite "WTO Trade Remedies Data Portal" |
| EU TRON: EU trade defence cases, CN codes, provisional and final duty dates | `eu_tron/` | the same step | European Commission public data |

TTBD's safeguards (`Global safeguard measures`) come from the TTBD download above.

```sh
uv run python -m trade_risk.harshness_cases download   # WTO portal and EU TRON pages (cached; about 1 h the first time)
uv run python -m trade_risk.harshness_cases build      # one case table, outcomes from all sources -> harshness_cases.parquet
uv run python -m trade_risk.harshness build            # rows, labels, features -> harshness.parquet
uv run python -m trade_risk.harshness tune             # model settings, picked on 2015-2017
uv run python -m trade_risk.harshness compare          # walk-forward test of every label -> models/harshness/<run>/ (HARSHNESS_RUN names the run)
```
