# ML (offline models)

Offline models for ExportMate.

- **Trade defence risk model** (`trade_risk/`): will a market open an anti-dumping or anti-subsidy
  case against an exporting country on a product next year? Design:
  `docs/local/TRADE_DEFENCE_RISK_MODEL.md`; test results: `docs/local/TRADE_DEFENCE_RISK_RESULTS.md`.
  See "Trade defence risk model" below.
- News severity: stopped in November 2026 (Gemini with a written rubric does it in the news scan);
  its GTA notes stay below.

## Layout

```
ml/
  pyproject.toml # Python dependencies (uv)
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

## What we have

| File | What it is |
| --- | --- |
| `data/raw/gta/gta_interventions_wood_2020-2026.csv` | Global Trade Alert, downloaded 2026-10-15. 2,614 measures announced 2020-01-01 → 2026-10-12 affecting HS chapters 44, 45, 46, 47, 48, 94. Ratings: 1,753 red, 758 green, 103 amber. 19 columns (ID, URL, title, GTA evaluation, jurisdictions, intervention type, MAST chapter, sectors, HS products, dates, in force). No description column, only the title |

How it was exported: globaltradealert.org/data-center → Tailor search →
GTA Evaluations Any, Affected Products 44 45 46 47 48 94, Announcement Period
2020-01-01 → today, both "keep interventions without … date" boxes ticked,
everything else Any or empty → Export → GTA entries → CSV.

### Notes before training

- GTA's rating is not our severity. Red = harms foreign trade, green = opens
  trade up (closer to good news than to "low"). A grant to local firms is red but
  rarely matters to an exporter; an export ban almost always does. Use the rating
  as one feature next to the measure type and whether it hits the company's
  products and markets.
- We need our own labels: a person rates ~200–300 measures high / medium / low for
  a wood/furniture exporter (balanced mix of ratings and types). That is the answer
  key; GTA's rating is an input.
- Amber is thin (103). Export 2 below adds more.

## Data sources to come back to

| Source | URL | Access | Use | Status |
| --- | --- | --- | --- | --- |
| Global Trade Alert: Data Center | https://www.globaltradealert.org/data-center | Free account, CSV export | Measures with red/amber/green rating, type, HS codes, dates | **Downloaded** (wood). To do: Export 2 with HS 03, 08, 09, 16, 18, 20, 52, 61, 62, 63 |
| Global Trade Alert: API | https://globaltradealert.org/llms/quickstart-gta-endpoints.md | API key on request | Same data, plus descriptions, without manual exports | Later |
| GTA MCP server (docs of fields and ratings) | https://pypi.org/project/sgept-gta-mcp/ | Free | Explains the data | Reference |
| GTA measure pages | `Intervention URL` column, e.g. https://globaltradealert.org/intervention/78233 | Public pages | Full description text if titles aren't enough | Later |
| WTO Trade Monitoring Database | https://data.wto.org/dataset/wto_tmdb · https://tmdb.wto.org/ | Free | Measures with HS codes and type (ban, tariff, licence) | Not downloaded |
| WTO Quantitative Restrictions | https://data.wto.org/en/dataset/ext_qr | Free | Bans and quotas (examples of "high") | Not downloaded |
| Kiel Trade & Tariff Monitor | https://trade.ifw-kiel.de/ · docs https://trade.ifw-kiel.de/KTTM/tariff_deltas/documentation_kttm_tariff_deltas.pdf | Free CSV | Size of tariff changes (a feature) | Not downloaded |
| NewsCatcher tariffs monitor | https://www.newscatcherapi.com/data/import-tariffs-monitor | Paid | Tariff news | Skip unless budget |
| Our scan golden set | `ai/server/eval/scan-golden.js` | In repo | 19 labelled articles (8 with severity): test set only | Have |

Sources for the knowledge graph (phase 1: HS codes and the material chain) are in
`backend/app/knowledge_graph/README.md`, section 3, with the graph's data.

Kaggle: no dataset fits; downloading needs your own account token.

## Moving to GCP later

Training runs on a laptop first. Later, the raw files go to a Cloud Storage
bucket and training runs on Vertex AI (custom training job), reading from
that bucket instead of `data/`.
