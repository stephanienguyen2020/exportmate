# ML (offline models)

Offline models for ExportMate, starting with news severity.
Nothing here runs in the app yet.

## Layout

```
ml/
  data/          # git-ignored: downloaded and prepared data
    raw/         # files exactly as downloaded, one folder per source
      gta/       # Global Trade Alert "GTA entries" CSV exports
```

Later folders (add when needed): `notebooks/` for exploration, `src/` for data
preparation and training code, `models/` (git-ignored) for trained weights.

`data/` is never committed. Each person downloads the files themselves.
Check each source's terms before training on it.

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
