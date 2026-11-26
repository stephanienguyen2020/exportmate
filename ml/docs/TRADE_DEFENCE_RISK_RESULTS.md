# Trade defence risk model: results

What each test of the model found, newest first. The design (use case, data, features, how it is
trained and served) is in [`TRADE_DEFENCE_RISK_MODEL.md`](TRADE_DEFENCE_RISK_MODEL.md); the code and
how to run it, in [`ml/README.md`](../README.md). Each run's files are in
`ml/models/trade_risk/<date>/` (`compare.json`, `report.json`, the model files).

How to read the numbers:
- A **row** is one flow in one year: one market buying one product (HS 6) from one exporting
  country, at least $1 million. About 470,000 rows a year; about 1 in 1,000 is followed by a case
  the next year.
- **Found in the top 5%**: rank all of a year's rows by score; of the rows that really got a case
  the next year, the share that were in the top 5%. The top 5% is what the app calls medium or high
  risk, the top 1% high.
- **AUC**: the chance that a row with a case ranks above a row without one (0.5 = guessing,
  1 = perfect).
- **Average precision**: how high the rows with a case rank, counting the very top most. With 1 row
  in 1,000 having a case, guessing scores 0.001.
- **Walk-forward**: each test year is scored by a model trained only on the years before it, as the
  yearly retrain will be.

## Training (25 Nov 2026)

Every model was tuned on 2016–2018 (design, "2. Train, evaluate, deploy"), then tested walk-forward
on the figures of 2019–2023 (the cases of 2020–2024): 2.36 million rows, 2,318 of them with a case
the next year. All 33 features.

### Which model

Averages over the five test years:

| Model | Found in the top 5% | In the top 1% | AUC | Average precision |
| --- | --- | --- | --- | --- |
| Rule: "share grew fastest" | 7% | 1% | 0.534 | 0.001 |
| Rule: "this product is already being cased" | 34% | 14% | 0.815 | 0.010 |
| Small neural network | 59% | 27% | 0.901 | 0.021 |
| Logistic regression | 70% | 39% | 0.937 | 0.031 |
| Random forest | 73% | 39% | 0.937 | 0.041 |
| LightGBM, random forest mode | 73% | 38% | 0.945 | 0.034 |
| XGBoost | 73% | 39% | 0.944 | 0.031 |
| CatBoost | 74% | 38% | 0.944 | 0.033 |
| LightGBM | 74% | 39% | 0.945 | 0.032 |
| **LightGBM, XGBoost and CatBoost averaged (chosen)** | **76%** | **40%** | **0.947** | **0.034** |
| The same with both forests (ranks averaged) | 75% | 42% | 0.947 | 0.037 |

Year by year, found in the top 5%:

| Figures of (cases the year after) | 2019 | 2020 | 2021 | 2022 | 2023 |
| --- | --- | --- | --- | --- | --- |
| Rows with a case | 580 | 504 | 224 | 415 | 595 |
| LightGBM | 70% | 71% | 77% | 76% | 76% |
| XGBoost | 70% | 68% | 78% | 77% | 75% |
| CatBoost | 69% | 73% | 79% | 75% | 76% |
| **The three averaged** | **72%** | **72%** | **82%** | **78%** | **76%** |

- Every trained model beats the rules by far: the "already being cased" rule finds 34%, the models
  59–76%.
- Alone, the tree models are close to each other (73–74%). The average of the three boosted ones
  finds 76%, more than each of them in 4 of the 5 test years (in 2020 CatBoost alone found 73%, the
  average 72%).
- **Why this average:** each of the three estimates the probability of a case, so the average of
  their log-odds is a probability too. It scores one order on its own, and its explanation (SHAP) is
  exactly the average of theirs, so the reasons stay exact. Averaging their ranks instead gave about
  the same (76%, 39%) but needs all of a year's rows at once.
- **Why not with the forests:** a point less in the top 5% (75%), two more in the top 1% (42%).
  But the forests' scores aren't probabilities, so they only average as ranks (all rows at once,
  not one order), and the random forest can't explain its scores.
- The cost: three models to train and serve instead of one.
- The random forest has the best average precision (0.041), from two good years (2020, 2021), but
  finds fewer cases in the top 5% (73%).

### Which features help

LightGBM with fewer features, the same test:

| Features | Found in the top 5% | In the top 1% | AUC |
| --- | --- | --- | --- |
| Trade figures only (19) | 43% | 14% | 0.856 |
| Case history only (14) | 68% | 36% | 0.926 |
| The design's first 19 | 65% | 34% | 0.924 |
| All but the three newest (30) | 71% | 38% | 0.938 |
| All 33 | 74% | 39% | 0.945 |

- **Case history carries most of it.** Where cases already happen (markets that use these tools a
  lot, products cased elsewhere, duties against other countries) finds 68% alone; the trade figures
  alone find 43%; together 74%. So the model mostly says "cases are spreading here", and the trade
  figures pick which flows within that.
- The 14 features added on 24 Nov 2026 raise it from 65% to 74%. All stay.
- The three newest (duties in force on the product, or on its heading, against other countries;
  growth against the market's growth) raise it from 71% to 74%, better in 4 of the 5 years.

### Checks of the chosen model

**Risk levels** (walk-forward 2019–2023; each year's rows ranked among all markets):

| Level | Rows | With a case the next year | Case rate | Against the average |
| --- | --- | --- | --- | --- |
| High (top 1%) | 23,570 | 910 | 3.9% (1 in 26) | 39× |
| Medium (next 4%) | 94,263 | 830 | 0.88% (1 in 114) | 9× |
| Low (the rest) | 2,238,785 | 578 | 0.026% (1 in 3,900) | 0.26× |
| All | 2,356,618 | 2,318 | 0.098% (1 in 1,000) | 1× |

So the app can say "high: about 1 in 26 such flows got a case the next year, about 40 times the
average".

**Per case, not per row** (a case often covers several products): of the 1,124 cases opened in
2020–2024 with a flow of $1M or more the year before, 847 (75%) had a row in the top 5% and 454
(40%) in the top 1%.

**The 2025 US cases**: what the app would have said at the start of 2025. Trained on 2013–2023
only, scoring the 2024 figures, ranked among all markets' 2024 rows:
- 68 US cases opened in 2025, all with a 2024 flow of $1M or more: **63 (93%) in the top 5%**, 31
  (46%) in the top 1%. Rows: AUC 0.916.
- By product and exporter (39 pairs): 17 high, 18 medium, 4 low (dissolving pulp from Brazil and
  Norway, silicon metal from Angola, corrugated plastic boxes from Vietnam).
- **Vietnam's plywood** (Hardwood and Decorative Plywood, opened in 2025 against China, Indonesia
  and Vietnam): **medium**, top 1.44% of all 2024 flows (high starts at 1%). Its reasons: the US
  opened 23 cases against Vietnam in the last 5 years; Vietnam sells $440M of it a year to the US;
  the US has duties in force on plywood (HS 4412) against China. Similar past case: the US against
  China, hardwood plywood, 2016, duty imposed. China's plywood was high (top 0.48%), Indonesia's
  medium (top 2.07%).
- Vietnam's other 2025 US cases: steel rebar high (top 0.23%), truck chassis medium (top 2.8%),
  corrugated plastic boxes low (top 7.6%).

**By market** (walk-forward; each market's rows ranked among themselves):

| Market | Rows with a case | AUC | Found in the market's own top 5% |
| --- | --- | --- | --- |
| India | 767 | 0.901 | 47% |
| US | 637 | 0.882 | 45% |
| Turkey | 166 | 0.955 | 68% |
| EU | 147 | 0.973 | 82% |
| Brazil | 75 | 0.914 | 52% |
| Vietnam (importing) | 67 | 0.855 | 41% |
| Canada | 63 | 0.919 | 63% |
| Australia | 57 | 0.981 | 91% |
| China (importing) | 43 | 0.412 | 45% |
| Gulf (GCC) | 38 | 0.936 | 74% |
| Mexico | 38 | 0.934 | 50% |
| Argentina | 32 | 0.821 | 30% |
| Pakistan | 27 | 0.872 | 31% |
| Malaysia | 23 | 0.978 | 96% |

- Inside one market ranking is harder than across all of them: India and the US, the busiest
  users, rank about half their cases in their own top 5%, because so many of their flows look
  risky. The levels are set across all markets, so 26% of India's flows and 17% of the US's are
  medium or high (5% overall); within them the levels still separate (India: a case after 6.7% of
  high flows, 1.5% of medium, 0.1% of low).
- **China as an importer: no better than guessing** (AUC 0.41). Its 12 cases of 2020–2024
  (chemicals and plastics from the US, wine from Australia, brandy and dairy from the EU) mostly came
  during trade disputes, not after import surges, so they don't follow the other markets' patterns;
  scores for exports into China mean little.

**Markets left out of training** (trained on 2013–2020 without the market, tested on its
2021–2023 rows):

| Market | AUC, trained with it | AUC, never seen |
| --- | --- | --- |
| US | 0.905 | 0.881 |
| India | 0.900 | 0.895 |
| EU | 0.964 | 0.963 |
| Brazil | 0.910 | 0.910 |
| Turkey | 0.965 | 0.964 |
| Australia | 0.980 | 0.977 |
| Canada | 0.960 | 0.955 |

Almost the same: what the model learns carries over to markets it never saw.

**Exports from Vietnam:** walk-forward, 98 rows with a case, AUC 0.957, 78 of them (80%) in the
top 5% of all rows. In the 2024 scores, 454 of Vietnam's wood and furniture flows (HS 44, 94) are
$1M or more: 10 high, 39 medium. The highest are fiberboard and MDF into India (HS 4411: India has
duties in force on them against 4 other countries, and cased Vietnam's MDF in 2020), then US
furniture, mattresses and prefabricated buildings (HS 9403, 9401, 9404, 9406) and Canada's
mattresses.

**What moves the scores** (share of the mean absolute SHAP value, 50,000 rows of 2024):
`market_cases_against_exporter_last_5y` 12.8%, `unit_price_vs_market_average` 10.5%,
`hs_chapter` 9.4%, `import_value_usd` 8.8%, `cases_on_product_all_markets_last_2y` 7.6%,
`market_cases_opened_last_3y` 6.9%, `market_cases_opened_this_year` 6.7%,
`market_supplier_count` 6.3%, `market_duties_in_force_on_heading_against_others` 5.7%,
`cases_against_exporter_all_markets_last_5y` 3.3%. Most rows are low, so this is what moves scores
in general, up or down; a high row's top reasons are usually its case history (the plywood one
above).

### First pass: one validation window (24 Nov 2026)

The first pass tuned on 2017–2018 only, with 30 features. Its settings looked better there than on
the test years (LightGBM's average precision 0.059 on validation, 0.028 on the test), so tuning
moved to three years. With the same 30 features LightGBM found 71% in its top 5% both times; the
three newest features then raised it to 74%.

### Caveats

- Outside the US, the 2023 rows' labels miss the cases of the last quarter of 2024 (design, "Limits
  of the data", 1), so 2023's numbers are a little low; the 2024 scores can be checked against real
  cases for the US only.
- The 2025 check is one market in one year (68 cases): it shows the model would have warned, not a
  precise rate.
- The tuning years score higher than the test years; only the test numbers are quoted.

## Backtest: Comtrade input (24 Nov 2026)

Does the model, trained on BACI, score as well when its input comes from Comtrade? The same model
(trained on BACI up to 2021) scored the same 881 rows (96 sampled market and product pairs, 72
rows with a case in 2024) from three inputs. 300 Comtrade calls; script
`ml/data/baseline_scripts/backtest.py`.

| Input | AUC | Real 2024 cases in the top 5% |
| --- | --- | --- |
| Comtrade, 2023 monthly figures summed (what the app would use) | **0.874** | **23 of 72** |
| BACI 2023 (the cleaned yearly figures, published a year later) | 0.869 | 21 of 72 |
| BACI 2021 (what a BACI-only app had at the end of 2023) | 0.855 | 16 of 65 |

- Comtrade scores as well as BACI: the two rank rows almost the same way (rank correlation 0.97).
  Values, growth and share match closely (correlation 0.84–0.96); unit price change matches less
  (0.52), as Comtrade's raw weights are noisier.
- Fresh figures help: two-year-old figures find fewer cases (16 against 23).
- 4 of 100 pairs had no full year of monthly figures (the BACI fallback covers them).
- A small sample: it shows the design works, not the final accuracy.

## Baseline (23 Nov 2026)

A quick LightGBM model on the design's first 19 features, trained on 2013–2020 and tested on
2021–2023 (1.18 million test rows, 832 with a case the year after). Not tuned; for deciding whether
to build it.

| | Result |
| --- | --- |
| AUC (0.5 = guessing) | **0.945** |
| Real cases found in the top 1% of each year's rows | 33% |
| Real cases found in the top 5% | **71%** |
| A rule: "share grew fastest" | AUC 0.53 (no better than guessing) |
| By market (AUC) | Australia 0.99, EU 0.96, Turkey 0.96, Canada 0.93, Brazil 0.91, Mexico 0.91, India 0.89, US 0.86 |
| Trained without one market, tested on it | India 0.89, Brazil 0.91, US 0.84: almost the same, so it carries over to markets it never saw |
| Exports from Vietnam | AUC 0.94; top 5% finds 76% of its 42 cases |

The strongest features were market size, the exporter's share, import value, the market's 3-year
growth, the share's 3-year change and the unit value change: the same things the law asks a
petition to show.
