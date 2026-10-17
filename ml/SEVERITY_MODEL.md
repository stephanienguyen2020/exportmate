# Severity model: design

Phase 2 of [`docs/NEWS_IMPACT_PLAN.md`](../docs/NEWS_IMPACT_PLAN.md). Not built. Data sources and files: [README.md](README.md).

## What it decides
- **Output:** `low` / `medium` / `high` and a confidence (0–1). Below a threshold (say 0.6) the alert is marked "needs a person" instead of guessing. Later, possibly `not relevant` as a fourth class (today `ai/server/relevance.js` decides that).
- **Severity has two parts**, and they come from different places:
  - **How bad the measure is** (a ban is worse than a consultation, a date in 30 days is worse than one in 2 years). A model can learn this from public data.
  - **How much it touches this company** (how many of its orders, how much value, which markets). Code computes this from the stock and orders, and from phase 1's graph.

  The model takes both as input.

## Labels

| Data | Where | How much | Usable as labels? |
| --- | --- | --- | --- |
| Hand-labelled articles for the scan eval | `ai/server/eval/scan-golden.js` | 19 articles, 8 with an expected severity | Yes, as a **test set** only: far too few to train on |
| Past scans: articles and alerts with Gemini's severity | Firestore (`articles`, `impacts`; mostly in the old project `exportmate-app`) | A few hundred articles (the new project has one scan: 58 articles, 9 alerts) | **No:** they are Gemini's own answers; training on them only copies Gemini |
| People's verdicts on which orders an alert affects | Backend `news_order_reviews` | Almost none yet | Yes, once collected: "this news really mattered to us" |
| Global Trade Alert measures | `data/raw/gta/` | 2,614 (wood, 2020–2026): 1,753 red, 758 green, 103 amber | **As a feature, not the answer** (see below) |
| Measures rated by hand | To make | ~200–300, balanced across GTA ratings and measure types | Yes: the answer key |

**Why GTA's rating isn't our label:** red means "harms foreign trade", green "opens trade up" (closer to good news than to "low"). A grant to local firms is red but rarely matters to an exporter; an export ban almost always does. So the GTA rating is one feature next to the measure type and whether it hits the company's products and markets. A person rates a sample by hand for a wood/furniture exporter; a script can pick the sample and write a CSV with an empty `our_severity` column.

## Features
Computed in code:
- Measure: GTA rating, intervention type (ban, tariff, licence, grant…), MAST chapter, still in force, implementing country.
- Timing: days until a date the article names (or the measure's implementation date).
- Company: whether it names a market the company ships to; an HS code or material the company holds; how many orders and how much value it touches (phase 1).
- Text: the article's embedding (the scan already computes one); action words (ban, tariff, suspend, delay, quota); the source (official journal or blog).

## Which model
Train several, measure them the same way, keep the best, and prefer the simpler one when they are close.

| Candidate | Input | Good | Watch out |
| --- | --- | --- | --- |
| **Rules** (baseline) | Features in code | Explainable, no training | Rigid |
| **Logistic regression** | Embedding + features | Works with little data; its weights fit in a JSON file, so it runs inside the Node AI service | Linear |
| **Gradient boosting** (LightGBM / XGBoost) | Features (+ a few embedding components) | Usually the best on table-like features | Needs a Python step or ONNX to run next to Node |
| **Small fine-tuned language model** (e.g. a multilingual DistilBERT) | Article text | Best on text, Vietnamese too | Needs thousands of labels; heavier to run |
| **Gemini as it is today** | Prompt | No training | The one to beat; it can drift between versions |

**How to choose:** the same held-out test set for every model (our 19 labelled articles plus hand-rated measures), scored on **recall of `high`** (missing a serious alert is the worst error) and macro-F1 over the three classes. Re-check monthly as verdicts come in.

## Workflow

```
Training (offline, e.g. monthly; code in ml/src, later a Vertex AI custom training job):
  public data + hand ratings + verdicts → features + embeddings → train the candidates
  → score on the test set → keep the best → save it (weights file) with its scores

Daily scan (ai/server):
  article → embedding + features → model → severity + confidence
     confidence high → use it;  low → "needs a person"
  Gemini writes only the "why"; the alert records which model and version decided
```

## Steps
1. **Collect labels now:** a "severity right / wrong" control on News watch next to the existing order verdicts; store them in the backend.
2. Public data: GTA wood export done; add Export 2 (food, textiles) for more amber. Check GTA's licence.
3. Rate ~200–300 measures by hand.
4. Compute the features in code (most come from the scan already).
5. Train logistic regression and gradient boosting; compare them with Gemini on the test set.
6. If one beats Gemini on `high` recall, run it in the scan next to Gemini for a few weeks (both saved, Gemini's shown), then switch.
7. Move training to GCP: raw files to a Cloud Storage bucket, training as a Vertex AI custom training job.
