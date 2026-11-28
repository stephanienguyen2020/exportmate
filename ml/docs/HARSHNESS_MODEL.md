# Harshness model: design

Severity model v2. When a news article reports a trade defence case, the model scores how badly the
case will hurt trade in that product from that country to that market. What each test found is in
[`HARSHNESS_RESULTS.md`](HARSHNESS_RESULTS.md). It borrows data and code from the trade defence risk
model ([`TRADE_DEFENCE_RISK_MODEL.md`](TRADE_DEFENCE_RISK_MODEL.md)).

## In one paragraph

An article reports a measure (for example "US opens an anti-dumping case on plywood from Vietnam").
The model gives the measure a harshness score, the same for every company. Then the graph walk finds
which companies' orders the measure reaches, and a rule turns the score into each company's
severity. The model learns from what really happened after past cases (did imports fall), not from
our opinions. That is the big change from version 1, whose labels were our own ratings, so it only
learned our rubric back.

## Words we use

- **Case:** a government's investigation into imports of a product from one or more countries.
  - **Anti-dumping:** goods sold below their home price.
  - **Anti-subsidy:** goods helped by their government.
  - **Safeguard:** a sudden surge from everyone, so a safeguard names no country.
- **The day a case opens:** the day the government announces the investigation (the "initiation
  date"). A duty, if any, comes 6-18 months later.
- **Market:** the importing country that opened the case (the US).
- **Origin:** the exporting country the case names (Vietnam).
- **Buyers:** the companies in the market that import the product.
- **Other suppliers:** other countries already selling the same product to that market. Buyers can
  switch to them.
- **Row:** what the model scores: one case on one market, one origin and one HS 6 code. An article
  can name several origins or products, so it can give several rows.
- **Harshness:** how badly the case hurts trade on that row. The same for every company.
- **Features:** what is known on the day the case opens.
- **Label:** what happened after. The model learns to predict it.
- **Company severity:** harshness plus how much the case touches one company. Low, medium or high.

## Where it sits in the app

```
News scan job (the backend's daily Cloud Run job, exportmate-backend-news-scan; not new), once per article
  1. Read articles from the news feeds
  2. Gemini: is it relevant, which goods, what it names (mentions),
     and the measure: kind, stage, markets, origins, product, its HS codes,
     duty if given; saved on the alert as `measure`                              (built)
  3. Code turns the measure into rows: every market x origin x HS 6 it names     (new)
  4. Start the Order features job with the rows (as an order's new pair does)    (new)
        │
        ▼
Order features job (ml/, the trade risk job: it owns both models)
  5. Build each row's features (Comtrade, or BACI), as it does for order pairs
     Harshness for each row:                                                      (new)
     - anti-dumping, anti-subsidy, safeguard: the model
     - any other kind: Gemini, given the row's trade figures and the rules
       the model learned
     Save the rows in Postgres (measure_scores), one set per article,
     shared by every company
        │
        ▼
Backend, per company (when News watch or the report reads the alert)
  6. Walk the knowledge graph: which of its orders the measure reaches            (as today)
  7. Rule: the row that matches each order + its exposure = company severity,
     with its reason                                                              (new: the rule)
  8. A person confirms or rejects each suggested order                            (as today)
        │
        ▼
News watch, company report, the assistant
```

**Step 2, the measure.** The scan assesses each article once per company that may be affected,
so each company's alert carries its own copy of the measure (`clean_measure` in
`backend/app/services/news_scan_rules.py` keeps only well-formed values; the fields are in
`backend/docs/API.md`, `GET /news-alerts`). The scoring step takes one per article. Codes are
checked for form only there: the scan job has no database, so whether a code exists in
`hs_headings` is checked where the rows are scored.

**Step 3, the rows.** "US opens a case on plywood from Vietnam and China" gives two rows: US, VN,
441231 and US, CN, 441231. If the article names only a heading (4412, plywood), code takes the HS 6
codes under it that the market really imports from that origin (from BACI), so each row has trade
figures. A cap (say 20 rows per article) keeps a vague article from making hundreds. A safeguard
names no origin, so it gives a row for each of the market's 10 biggest suppliers of the product.

**Step 7, which row.** An order's row is its own pair: destination market, the company's country,
the order's HS 6 (the same pair the trade risk model scores, `order_trade_pairs`). If the article has
that exact row, the rule uses it. If the walk reached the order another way (through a supplier's
material, or the same heading), the rule uses the article's highest row.

Example: "US opens an anti-dumping case on Vietnamese plywood".
- Steps 2 and 3 give the row US, VN, 441231, anti-dumping, opening.
- Step 5 scores it harsh: Vietnam sells most of the US's plywood imports, its sales grew fast, and
  imports fell after most past US cases.
- Step 6 finds company A's two plywood orders to the US, shipping in three weeks.
- Step 7 makes it **high** for company A. For company B, which only ships chairs to the EU, the walk
  finds nothing, so it is **low**.

## What changes from today

**Today:** in step 2, Gemini rates severity with a written rubric (`news_scan_rules.py`). It rates
the measure and the company's goods together, in one answer, for each company it assesses.

**With v2:**
- Gemini still reads the article and finds the goods and mentions. It also writes down the measure
  (kind, stage, market, origins, duty) and the product's HS codes in their own field (`productHs`,
  from its knowledge of the HS when the article doesn't state them). `mentions.hsCodes` stays what
  the article states, for the knowledge graph. Reading is what Gemini is good at.
- **Anti-dumping, anti-subsidy and safeguards:** the model gives harshness, not Gemini. These are
  the kinds with good label data.
- **Every other kind** (tariff changes, bans, quotas, product rules such as food safety or EUDR,
  anything else): Gemini still gives harshness, but it rates only the measure, not the company, and
  it is given the row's trade figures (from the Order features job) and the rules the model learned
  (in the results doc). That lifted Gemini from guessing to near the model on the case test. So both paths give the same thing to step 7. A kind moves to the model later only when
  it has label data (see "Order of kinds").
- **The company part moves to a rule in code (step 7)** for every kind. Same facts in, same answer
  out, and the reason can be shown ("high: hits two orders worth $42,000 shipping in 3 weeks").
- Each kind moves from Gemini to the model only after the model beats Gemini on it (see "How we
  test it"). Until then nothing changes for that kind.

**The company rule (first version, to tune):**
- Start from harshness (low, medium, high).
- Up one level if the walk reaches open orders shipping within 90 days.
- Down one level if the walk reaches no open orders, only goods from the profile.
- Never up when the only path uses a doubted link (people rejected it before).
- No match at all: no alert for that company, as today.

## The model

### Rows

One row per (case, market, origin, HS 6), dated the day the case opened. Cases opened 2013-2025: the
features need the year before (BACI starts in 2012).

Why the day the case opened and not the article's date: we train on case records, not articles. One
case gets many articles over months (the petition, the opening, the preliminary duty, the final
duty), and we have no articles for most past cases. The opening is the one date every case has.
When scoring live, the row is the measure the article reports, and the features are the latest
figures we have.

Later stages (preliminary duty, final duty) are handled by a rule for now: see open question 2.

### Labels

Five candidates are built and tested; the results doc says which one won.
1. **Ended in a duty:** the case reached a final duty, yes or no. A case with no decision yet is
   "pending" and has no label; a case with no duty 2 years after it opened counts as "no duty".
2. **Imports fell:** imports of the product from that origin into that market, in the better of the
   2 years after the opening year, were at most half of the year before the opening. A flow that
   stopped counts as fallen. From BACI, so only cases opened to 2022.
3. **Imports fell, compared with the rest of the market:** the origin's imports fell to at most half
   of how imports from the origins no case named moved. "China -70%, the rest -5%" counts; "China
   -60%, the rest -55%" doesn't: the whole market fell. Origins named by any case on the same goods
   that year or the year before don't count as the rest. Where the rest is under $1M the year
   before, or for a safeguard (no rest), the plain fall counts.
4. **Both:** ended in a duty and imports fell.
5. **Both, compared with the rest.**

Output: a probability, turned into low, medium or high with thresholds, like the trade risk model.

### Features

Everything must be known on the day the case opens, because that is when a real new case is scored.
So trade figures are from the year before, and past cases count only once their outcome was known.

About the case:
- kind: anti-dumping, anti-subsidy or safeguard
- how many origins and how many products the case names
- how often earlier cases ended in a duty: in this market, in this market for this kind, against
  this origin, in this market for this HS chapter (a case counts 2 years after it opened)
- how often imports fell after earlier cases: in this market, against this origin, in this HS
  chapter (a case counts 3 years after it opened)
- how many cases this market opened before

About the market the year before (BACI):
- the named origins' share of the market's imports of the product, and this origin's part of it
- the biggest other supplier's share, and how many other suppliers have over 1% (other suppliers
  that could take the origin's place)

About the trade flow: the trade risk model's features (`ml/trade_risk/features.py`), such as:
- size: imports of the product from this origin into this market
- the origin's share of the market (high = the market depends on it)
- the share of the origin's world exports that go to this market (high = it depends on the market)
- growth in the last year and the last 3 years (a surge)
- the origin's price per tonne against other suppliers
- how many suppliers the market has
- past cases on the same product and origin, duties in force

Not used: the dumped imports' share of all imports and the dumping margins on the WTO portal. They
come from the government's final report, so they don't exist yet on the day a case opens, and they
partly give the answer away (a margin is only reported when dumping was found).

### Which model

What won for trade risk: LightGBM, XGBoost and CatBoost, their log-odds averaged. Settings sized for
a few thousand rows (`PARAMS` in `harshness.py`).

## Data sources

| What | Source | Use | Have it? |
| --- | --- | --- | --- |
| Anti-dumping, anti-subsidy and safeguard cases, ~40 markets, to 2024 | World Bank TTBD (safeguards: `Global safeguard measures`) | Rows, case features, outcomes | Yes |
| Anti-dumping and anti-subsidy investigations, HS codes, conclusion, date the duty came into force, to mid-2026 | WTO Trade Remedies Data Portal (`ml/data/raw/wto_trade_remedies/`) | Outcomes TTBD lacks, new cases | Yes |
| EU investigations, CN codes, provisional and final duty dates | EU TRON (`ml/data/raw/eu_tron/`) | Fills EU gaps | Yes |
| US cases from 2023 on | US Federal Register | Rows, outcomes | Yes (trade risk) |
| Yearly imports by market, origin, HS 6, 2012-2024 | CEPII BACI | Trade features, import labels | Yes (trade risk) |
| Recent monthly imports | UN Comtrade | Trade features when scoring live | Yes (trade risk job) |
| HS edition conversion | WITS concordance | Match codes across HS editions | Yes (trade risk) |
| Tariff changes, bans, quotas | Global Trade Alert (licence to check), WITS/TRAINS or WTO tariff data, WTO quantitative restrictions | Later kinds | No |
| Product rules (food safety, technical rules) | WTO ePing and Trade Concerns; EU RASFF and US FDA border rejections | Last kind | No |

How sources are joined (`harshness_cases.py`): a WTO or EU case is the same as a TTBD case when the
market, origin and kind match and they opened within 45 days of each other. TTBD's record is kept
and the other fills its missing outcome and dates; cases TTBD doesn't have are added. A WTO case
whose conclusion is "affirmative" but has no date the duty came into force counts as "no duty" once
2 years have passed (India often found dumping but never imposed the duty).

Limits:
- The WTO portal is complete from 2023; before that it mainly keeps cases whose duty was in force on
  or after 2020.
- EU TRON lists almost only cases that ended in a duty, so it only fills gaps.
- The US trade commission's case database needs a sign-in; the WTO data covers US cases.

## Order of kinds

1. **Anti-dumping, anti-subsidy, safeguards.** Clear outcomes. First.
2. **Tariff changes, bans, quotas.** Needs Global Trade Alert (check its licence) and tariff rates.
   The label is imports fell.
3. **Product rules.** Hard: rules rarely "end", products are named loosely, and the label (border
   rejections) is a separate dataset. Probably stays with Gemini's rubric.

## How we test it

1. **Backtest (walk-forward):** for each test year, train on cases opened before it and score the
   cases opened in it. Does the model rank the cases that really cut imports near the top? Each
   case counts once in the scores (its rows weighted by 1 / its row count), so a case with 20 HS
   codes doesn't count 20 times.
2. **Settings** are picked on 2015-2017, before every test year, so the test stays untouched.
3. **Against Gemini:** for the test cases, write the opening-day headline from each case's record
   (market, kind, product, origins, date). Gemini rates each from the headline; the model scores the
   same cases. Which one rates the cases where imports really fell higher? (The 2,919 headlines
   collected for version 1 are from 2023-2026, too recent to know whether imports fell.)
4. **Keep the model for a kind only if it clearly beats Gemini there.** Otherwise Gemini stays for
   that kind.
5. **The company rule** is checked on the labelled scan articles (`news_scan_exam.py`) and on what
   people confirm or reject in News watch.

How to run it:

```sh
uv run python -m trade_risk.harshness_cases download   # WTO portal and EU TRON pages (cached)
uv run python -m trade_risk.harshness_cases build      # the case table with outcomes
uv run python -m trade_risk.harshness build            # rows, labels, features -> data/interim/trade_risk/harshness.parquet
uv run python -m trade_risk.harshness tune             # model settings, picked on 2015-2017
uv run python -m trade_risk.harshness compare          # walk-forward test of every label -> models/harshness/<run>/
```

## What we keep from version 1, and what we drop

Keep:
- The split: harshness once per measure, the company part separately.
- The rubric, for kinds the model doesn't cover.
- The rated articles, as a test set for the scan, not as training labels.
- The collected headlines, for the test against Gemini.

Drop:
- Labels that are our opinions (rated with our rubric).
- The Global Trade Alert export for wood only, and labels from one company's point of view.

## Why it can beat Gemini

- **Real labels:** it learns what really happened after past cases, not what we think.
- **Numbers Gemini can't see:** Gemini only reads the article. The model knows the trade figures and
  each market's history of cases.
- **We can check it:** on past cases where we know the answer.
- **Same input, same score**, and one score per measure, not one Gemini answer per company.

## Where it runs and where it is stored

- **Code:** in `ml/trade_risk/` (`harshness_cases.py`, `harshness.py`), next to the trade risk model,
  sharing its features and training code.
- **Stored:** a Postgres table `measure_scores`, one row per article x market x origin x HS 6: the
  measure's kind and stage, harshness (score and level), who scored it (model or Gemini), the model
  version and the date. Scored once, shared by every company. The per-company severity is worked out
  when the alert is read (steps 6 and 7), not stored.
- **Who scores:** the Order features job (`ml/`), the same job that scores trade risk. A measure row
  is a pair like an order's, so the job fetches its figures (Comtrade, or BACI) the same way, then
  scores it and saves it to `measure_scores`. The scan only starts the job with the rows. One job,
  two models; the backend image doesn't need LightGBM, XGBoost or CatBoost.
- **First stage (simple):** the job loads the model files itself. Until an alert's rows are saved,
  News watch says "The harshness score is being worked out. Check again later."
- **Model files:** training writes them to `ml/models/harshness/<run>/` (git-ignored), and the job
  loads the newest. In production they go into the job's Docker image or a Cloud Storage bucket; in
  the target design, Vertex AI Model Registry holds them and an endpoint loads them.
- **Target (diagram):** the Order features job calls two Vertex AI endpoints, trade risk and
  harshness (`docs/architecture/trade-defence-risk-architecture.excalidraw`, with the news part).

## Decided

1. Test every label; keep what tests best.
2. Store harshness once per row in `measure_scores`, shared by all companies.
3. Code lives in `ml/` with the trade risk model.
4. The Order features job scores harshness too (one job, two models). It loads the files first; a
   Vertex AI endpoint in the target design.
5. Start with option A for later stages (model at the opening only, a rule after).

## Open questions

1. Is "imports fell by half within 2 years" the right line for the import labels?
2. Later stages. A case goes: petition, opening, preliminary duty (about 6 months), final duty
   (about a year), then yearly reviews or revocation. The options:
   - **A. Model at the opening only, a rule after (planned first).** Preliminary duty: at least
     medium. Final duty in force: high. Revoked: low. Simple, and the opening is when the warning
     matters most.
   - **B. The model scores every stage.** Each time news about the case arrives, the model scores
     it again with what is known by then. Each past case gives up to three rows (at the opening, at
     the preliminary duty, at the final duty), each with only what was known that day; at the
     preliminary stage that includes the preliminary duty's size, which says a lot. The catch: at
     the final stage the case has already ended in a duty, so only the import labels teach anything.
     It needs each past case's preliminary date and duty (the EU's are in TRON).
   Start with A; try B once A works.
