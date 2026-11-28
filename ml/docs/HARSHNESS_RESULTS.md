# Harshness model: results

What each test of the model found, newest first. The design (rows, labels, features, data, how it is
tested and served) is in [`HARSHNESS_MODEL.md`](HARSHNESS_MODEL.md). Each run's files are in
`ml/models/harshness/<run>/` (`compare.json`, `tuned.json`).

How to read the numbers:
- A **row** is one case on one market, one origin and one HS 6 code. One case often covers many HS
  codes, so it gives many rows.
- **Per case:** each case counts once. Its rows share the market, origin, date and outcome, so
  without this a case with 20 HS codes would count 20 times. The model still scores each HS code;
  only the marking changes (each row weighted by 1 / its case's row count).
- **AUC:** the chance that a case where imports fell ranks above one where they didn't (0.5 =
  guessing, 1 = perfect).
- **Average precision:** how high the cases where imports fell rank, counting the very top most.
  Guessing scores the base rate.
- **Base rate:** the share of cases where it happened, for example 0.36 = 36% of cases.
- **Walk-forward:** each test year is scored by a model trained only on the years before it.

## Where it stands

- **Label:** "imports fell, compared with the rest of the market". Per case: AUC 0.70, average
  precision 0.57 against a base rate of 0.36.
- **The model beats Gemini clearly** on the same cases (AUC 0.69 against 0.49). Gemini's ratings
  from a headline alone are no better than guessing.
- **Given the trade figures and rules the model learned, Gemini gets to 0.64.** That is how Gemini
  should rate the kinds the model doesn't cover.
- **Gemini picks out the case from a real notice 92% of the time**, once it is asked for the
  product's HS code in its own field (the scan's prompt today gives none).
- **"Ended in a duty" can't be predicted** from what is known at the opening (AUC 0.56). Whether a
  duty is imposed is a government decision the trade figures don't show.
- **More trade features now add little.** The next big gain would come from scoring cases again at
  the preliminary duty (open question 2, option B in the design), whose size says a lot.

## Gemini given the figures and rules (27 Nov 2026)

The question: Gemini keeps rating the kinds the model doesn't cover (tariffs, bans, quotas). Can
what the model learned make Gemini better?

How: the same 1,278 test cases and headlines as "Against Gemini" below, plus for each case:
1. **Its figures** from the year before it opened (its biggest product): imports from the origin and
   their growth over 1 and 3 years, the origin's and all named origins' share of the market, the
   number of suppliers and of other origins over 1%, the origin's share of world exports, its price
   against the market average, and the share of the market's past cases where imports fell.
2. **Rules learned from the 2014-2017 cases** (before every test year; imports fell after 44%):

| What past cases showed | Imports fell after |
|---|---|
| Imports from the origin more than doubled in the last year | 55% (flat or falling: 36-38%) |
| 3 times or more what they were 3 years before | 58% |
| The named origins supply over 80% of the market | 55% (under 20%: 36%) |
| Few suppliers: at most 5 other origins over 1% | about 51% |
| Many suppliers: over 10 other origins over 1% | 26% |
| The origin is a small world exporter (under 5%) | 51% (20-50%: 34%) |
| 7 or more origins in the investigation | 54% (one origin: 37%) |
| Safeguards | 29% |

Per case, "imports fell vs the rest" (base rate 0.36):

| | Gemini, headline only | Gemini with figures and rules | Model |
|---|---|---|---|
| AUC | 0.49 | **0.64** | 0.69 |
| Average precision | 0.39 | 0.48 | 0.55 |
| Imports fell after its "high" cases | 32% | **55%** (75 cases) | |
| Imports fell after its "low" cases | 35% | **23%** (298 cases) | |

What it shows:
- **The figures and rules turn Gemini from guessing into a real rating** (AUC 0.49 to 0.64). In 2018
  it even beat the model (0.69 against 0.67); in the later years the model is ahead.
- **The model is still better**, so it keeps these three kinds.
- **For the kinds the model doesn't cover, give Gemini the row's trade figures and these rules.**
  The figures come from the same Order features job that scores the model's rows.
- **Surprise: many other suppliers means imports fell less often, not more.** The guess was that
  buyers switch away from an origin when others can take its place. In the data, when the named
  origins supply most of the market and there are few others, their imports fall most (against the
  rest of the market, which can grow from a small base).

Files: `models/harshness/2026-11-27-v4/` (`compare_gemini_facts.json`, `gemini_facts_ratings.parquet`).

## Can Gemini pick out the case from a real article? (27 Nov 2026)

In the app, Gemini reads the article and writes down the case; the model then scores it. If Gemini
names the wrong origin or product, the model scores the wrong thing.

How:
1. Real texts with a known answer: 76 US opening notices from the Federal Register (2018-2022:
   title and summary), each matched to its case (market, origins, HS codes, kind).
2. Gemini read them with the news scan's own rule for what an article names (`mentions`, copied
   from `news_scan_rules.py`), plus the two fields the plan adds: the kind of measure and its stage.
   10 notices per call, 30 seconds apart.
3. A second run added one field, `productHs`: the HS codes of the product the measure covers, from
   Gemini's own knowledge of the HS when the article doesn't state them.

| Right in | Scan's prompt today | With `productHs` |
|---|---|---|
| Market | 100% | 100% |
| Every origin, none added | 100% | 100% |
| Kind (anti-dumping, anti-subsidy) | 100% | 100% |
| Stage (opening) | 100% | 100% |
| HS heading (4 digits) | **0%** (no code given) | **92%** |
| HS subheading (6 digits) | 0% | 84% |
| The whole case | 0% | **92%** |

What it shows:
- **The scan's prompt never gives an HS code** for these: its rule says "leave a list empty rather
  than guess", and the notices name the product, not its code. Without a code there is no row to
  score.
- **Asking for the product's HS in its own field fixes it** (92% right). Keep it separate from
  `mentions.hsCodes`, which the knowledge graph matches on and should stay what the article states.
- The 6 misses are products that are hard to place: "corrosion inhibitors", "steel wheels" (trailer
  or car), "aluminum wire and cable". Gemini's "sure" flag doesn't separate right from wrong (92%
  against 91%), so it isn't worth using.

Catches:
- Official notices are clear. A news headline is vaguer ("India probes dumping of newsprint from 5
  countries" doesn't name them), so real news will do worse.
- We tried Google News for non-US cases: it keeps few 2018-2022 articles (6 found in 80 searches,
  2 of them about another case), too few to test.

## Against Gemini (27 Nov 2026)

The question: for anti-dumping, anti-subsidy and safeguard cases, should the model give harshness
instead of Gemini?

How:
1. The 1,278 test cases opened 2018-2022 (we know whether imports fell after each).
2. For each, an opening-day headline written from the case record, like the news would say it:
   "03 Jul 2019: IND opens an anti-dumping investigation into Flat-Rolled Stainless Steel Products
   from CHN. The same investigation also covers KOR, VNM, ...".
3. Gemini (gemini-3.5-flash, medium thinking) gave each case a probability that imports would fall
   and a level (low, medium, high). 20 cases per call, 30 seconds apart: 64 calls.
4. The model's scores are its walk-forward scores (new features, default settings), so it never saw
   the case it scored.

Why headlines written from records, not the 2,919 collected for version 1: those are from 2023-2026
(whether imports fell isn't known yet for those cases), and only 142 are about trade defence cases.

Per case, "imports fell vs the rest" (base rate 0.36):

| | Model | Gemini | Both averaged |
|---|---|---|---|
| AUC | **0.69** | 0.49 | 0.68 |
| Average precision | **0.55** | 0.39 | 0.51 |

The model wins in every test year (AUC 0.67-0.74; Gemini 0.44-0.56).

Share of cases where imports really fell, by level (the model's levels cut to the same sizes as
Gemini's):

| Level | Cases | Gemini | Model |
|---|---|---|---|
| High | 586 | 32% | **48%** |
| Medium | 588 | 40% | 27% |
| Low | 104 | 35% | **18%** |

What it shows:
- **Gemini can't tell which cases will cut imports:** its "high" cases fell no more often than its
  "low" ones. From a headline alone there is little to go on.
- **The model can:** its high cases fell 2.7 times as often as its low ones. It knows what the
  headline doesn't say: how much of the market the origin supplies, whether its sales were surging,
  how many other suppliers there are, and what happened after past cases in that market.
- **Averaging the two doesn't help:** Gemini only adds noise.
- So, per the plan, the model gives harshness for these three kinds. Gemini keeps reading the
  article (which case, market, origins, product).

Catches:
- The headlines are written from records, so they're plainer than real news. A real article may say
  more (the petitioners' claims, the alleged margin), which could help Gemini a little.
- Gemini may remember some 2018-2022 cases from its training. That would only help Gemini, and it
  still lost.

Files: `models/harshness/2026-11-27-v4/` (`compare_gemini.json`, `gemini_ratings.parquet`,
`model_scores.parquet`).

## Third try (27 Nov 2026): new features, tuning

Run `2026-11-27-v4`. Same 10,972 rows as the second try; test years 2018-2022.

Added 9 features, all known on the day a case opens:
- **The market the year before:** the named origins' share of the market, this origin's part of it,
  the biggest other supplier's share, and how many other suppliers have over 1%. The first guess was
  that buyers switch away when other suppliers can take the origin's place; the data showed the
  opposite (see "Gemini given the figures and rules").
- **Past outcomes:** how often imports fell after earlier cases in the same market, against the same
  origin, and in the same HS chapter; the market's duty rate in the same HS chapter.

Tuning: each model type tried its current settings plus 20 random ones, picked on 2015-2017.

| Per case | Old features | New features | New + tuned |
|---|---|---|---|
| Imports fell vs the rest, AUC | 0.69 | **0.70** | 0.70 |
| Imports fell vs the rest, average precision (base 0.36) | 0.54 | **0.57** | 0.56 |
| Ended in a duty, AUC | 0.56 | 0.56 | 0.57 |

Average precision per case for "imports fell vs the rest", by test year:

| Test year | 2018 | 2019 | 2020 | 2021 | 2022 |
|---|---|---|---|---|---|
| Old features | 0.59 | 0.48 | 0.50 | 0.56 | 0.55 |
| New features | 0.61 | 0.53 | 0.50 | 0.60 | 0.58 |

What it shows:
- **The new features help a little, in every test year**, so it isn't one lucky year. The named
  origins' share of the market is now the 3rd strongest feature.
- **Strongest features for imports falling:** the origin's recent import growth, how many suppliers
  the market has, and the named origins' share.
- **Tuning helped on 2015-2017 (+0.01 to +0.03 AUC) but not on the test years**, so the default
  settings stay.
- **"Ended in a duty" doesn't move.** It mostly follows how many origins and products a case names:
  bigger cases end in a duty more often.

## Second try (27 Nov 2026): more cases, better outcomes

New sources (see the design's data sources): the WTO Trade Remedies Data Portal (4,500
investigations, outcomes to mid-2026), EU TRON (290 EU cases, only to fill gaps), and safeguards
(452 cases, already in the TTBD download). Case table: 10,678 cases (was 2,489). Feature file
(`harshness.parquet`): 10,972 rows, 3,474 cases (was 5,332 rows).

What the new outcomes fixed:
- **TTBD left many recent cases open, and we counted them as "no duty".** With the WTO's outcomes,
  2019 goes from 27% to 62% of cases ending in a duty, and 2022 from 14% to 73%.
- **India really did change:** the WTO lists 102 Indian cases from 2019-2021 where dumping was found
  but the finance ministry never put the duty in force. These count as "no duty".
- Cases with no decision yet are "pending" and have no label (they were "no duty" before).

New label: imports fell, compared with the rest of the market (see the design).

Results (test years 2018-2022; ended in a duty to 2024):

| Label | AUC | AUC per case | Average precision per case (base rate) |
| --- | --- | --- | --- |
| Ended in a duty | 0.55 | 0.56 | 0.78 (0.73) |
| Imports fell | **0.71** | **0.69** | 0.41 (0.23) |
| Imports fell vs the rest | 0.69 | **0.69** | **0.54** (0.36) |
| Both | 0.70 | 0.68 | 0.33 (0.18) |
| Both vs the rest | 0.71 | 0.69 | 0.44 (0.28) |

What it shows:
- **Twice the data, the same scores.** The amount of data isn't what limits the model; the features
  are.
- **"Ended in a duty" is still weak (0.56)** even with correct outcomes.
- **"Imports fell" holds when each case counts once (0.69)**, so it doesn't come from a few big cases.
- **"Imports fell vs the rest" is as good,** and is the fairer label: it checks that the case caused
  the fall, not a slump in the whole market.
- Weighting training rows by case didn't help.

Catch: the 2024-2025 duty rates look high (85%, 90%) because the cases decided quickly are the ones
already known; slower ones are still pending.

## First try (26 Nov 2026)

TTBD anti-dumping and anti-subsidy cases only (no safeguards yet). Cases opened 2014-2022 whose flow
was $1M+ the year before: 5,332 rows, 2,075 cases. Walk-forward, test years 2018-2022, default
settings.

| Label | AUC | Average precision | Base rate | Best simple score (AUC) |
| --- | --- | --- | --- | --- |
| Ended in a duty | 0.52 | 0.64 | 0.58 | 0.49 (origin's share of the market) |
| Imports fell | **0.71** | **0.42** | 0.23 | 0.51 (market's past duty rate) |
| Both | **0.71** | **0.33** | 0.14 | 0.45 |

What it shows:
- **"Ended in a duty" looked like a coin toss (0.52).** Part of it was wrong outcomes: TTBD left
  recent cases open (fixed in the second try).
- **"Imports fell" works:** 0.67 AUC with trade features alone, 0.71 with the case features too.
- **"Both" works about as well,** so "imports fell" carries it.

Catches found:
- Rows of one case are alike, so the test has fewer independent cases than rows (fixed by scoring
  per case).
- Imports can fall for reasons other than the case, such as a market slump (fixed by the "vs the
  rest" label).
