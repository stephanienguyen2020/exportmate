# ML (offline models)

Offline models for ExportMate. Nothing here runs in the app yet.

- **Trade defence risk model (next):** from annual trade figures, how likely a market is to open an
  anti-dumping, anti-subsidy or safeguard case against an exporting country on a product next year,
  and why. Design: `docs/local/TRADE_DEFENCE_RISK_MODEL.md`. Its code isn't here yet; the data is
  below ("Trade defence risk data").
- **Severity model (stopped 23 Nov 2026):** rated how serious a news story is. Gemini given a clear
  rubric did nearly as well (macro-F1 0.79 against the best model's 0.75 on the 137 rated scan
  articles), so we stopped; the rubric goes into the scan's prompt and the labels stay as its
  evaluation set. Its code below is kept as it is; why we stopped: `docs/local/SEVERITY_MODEL.md`.

## Severity model (stopped)

## Layout

```
ml/
  pyproject.toml  # uv project
  src/
    prepare.py    # GTA CSV + Firestore articles/alerts → data/interim/*.parquet
    collect.py    # past trade headlines (Google News, Federal Register, GDELT) → training only
    sources.py    # the scan's articles (test set) and the collected ones (training) in one shape
    sample.py     # pick what to rate → labels/to_rate.csv
    extract.py    # Gemini reads each article into GTA's fields (measure type, countries, dates…)
    embed.py      # text embeddings (text-multilingual-embedding-002)
    features.py   # the one feature function, same for a GTA measure and an article
    evaluate.py   # every candidate vs Gemini, cross-validated on rated articles → models/<date>/
    llm_rate.py   # Gemini with labels/RUBRIC.md rates the same articles (the baseline that won)
    measure_types.py  # the closed list of measure types both sources map onto
  labels/
    RUBRIC.md     # what high, medium, low mean
    rated.csv     # the labels; GTA and collected rows keep only their ID (their text stays in data/)
  data/           # git-ignored: raw/ as downloaded, interim/ prepared
  models/         # git-ignored: reports and trained models by date
```

Run (needs `gcloud auth application-default login`; reads Firestore, calls Gemini and embeddings
in `skilful-scarab-511320-q9`):

```sh
cd ml
uv run python src/prepare.py
uv run python src/collect.py --source=google    # also google_vi, fedreg, gdelt; reruns add only new ones
uv run python src/sample.py      # only new items; rate them into labels/rated.csv
uv run python src/extract.py
uv run python src/embed.py
uv run python src/features.py
uv run python src/llm_rate.py    # Gemini with the rubric, for evaluate.py's comparison
uv run python src/evaluate.py    # prints and writes models/<date>/report.md
```

Design and plan: `docs/local/SEVERITY_MODEL.md`.

`data/` is never committed. Each person downloads the files themselves.
Check each source's terms before training on it. GTA (checked 22 Nov 2026): a free account holds
"Internal Use" only; we train on it for development and demo, never commit or show its data, and need
a Derived Use grant from SGEPT (or articles-only training) before a GTA-trained model serves customers.
Collected headlines: Google News feeds are for personal, non-commercial use, GDELT asks for
attribution ("GDELT Project"), the Federal Register is public domain; we keep headline, link, date and
publisher only, in `data/`, never committed.

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

## Trade defence risk data

Downloaded 23 Nov 2026 into `data/raw/` (never committed):

| File | What it is | Terms |
| --- | --- | --- |
| `data/raw/ttbd/` | World Bank **Temporary Trade Barriers Database** (Bown, Cieszkowsky, Erbahar, Signoret 2020), from https://www.worldbank.org/en/data/interactive/2021/03/02/temporary-trade-barriers-database ("All underlying data" zip). Anti-dumping and countervailing cases of ~30 importers, 1977–2024 (10,343 cases; 3,334 since 2010 with HS codes): importer, exporter, product, HS codes, dates, decisions, duties. One `.xls` per importer, sheets Master, Products, Domestic-Firms, Foreign-Firms | No licence on the page; public research data, cite the authors |
| `data/raw/baci/BACI_HS12_V202601.zip` | CEPII **BACI**, HS 2012, version 202601 (1.3 GB), from https://www.cepii.fr/DATA_DOWNLOAD/baci/data/BACI_HS12_V202601.zip. Annual trade 2012–2024 by exporter, importer and HS 6-digit product: value (thousand USD) and quantity (tonnes) | Etalab Open Licence 2.0: any use, cite "CEPII BACI" |

Reading the `.xls` files needs `xlrd` (`uv run --with xlrd …`). Monthly figures (UN Comtrade, US
Census) need a free key each, signed up by a person; annual figures are enough for a year-ahead warning.

## Moving to GCP later

Training runs on a laptop first. Later, the raw files go to a Cloud Storage
bucket and training runs on Vertex AI (custom training job), reading from
that bucket instead of `data/`.
