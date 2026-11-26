"""Why a score is high, in words, and the past cases closest to it.

Reasons come from the model's own explanation of each prediction (SHAP contributions, which trees
compute exactly): the features that pushed this row's score up the most, written as sentences.
"""

import numpy as np
import pandas as pd


def times(x: float) -> str:
    return f"{x:.1f}×"


def count(x: float, word: str, plural: str | None = None) -> str:
    """'1 case', '3 cases'."""
    n = int(round(x))
    return f"{n} {word if n == 1 else plural or word + 's'}"


# feature -> (sentence for the value, or None when the value doesn't read as a reason)
REASON_TEXT = {
    "import_value_vs_last_year": lambda x, r: f"imports grew {times(x)} in a year" if x >= 1.3 else None,
    "import_value_vs_3_years_ago": lambda x, r: f"imports are {times(x)} what they were 3 years before" if x >= 1.5 else None,
    "import_tonnes_vs_last_year": lambda x, r: f"the volume grew {times(x)} in a year" if x >= 1.3 else None,
    "is_new_flow": lambda x, r: f"{r['exporter']} is a new source of it for {r['market']}" if x >= 1 else None,
    "exporter_share_of_market": lambda x, r: f"{r['exporter']} holds {x:.0%} of {r['market']}'s imports of it" if x >= 0.05 else None,
    "exporter_share_change_1y": lambda x, r: f"{r['exporter']}'s share of {r['market']}'s imports rose {x * 100:.0f} points in a year" if x >= 0.02 else None,
    "exporter_share_change_3y": lambda x, r: f"{r['exporter']}'s share rose {x * 100:.0f} points in 3 years" if x >= 0.03 else None,
    "unit_price_vs_last_year": lambda x, r: f"its price per tonne fell {1 - x:.0%} in a year" if x <= 0.9 else None,
    "unit_price_vs_market_average": lambda x, r: f"its price is {1 - x:.0%} below the average of {r['market']}'s imports" if x <= 0.85 else None,
    "market_imports_vs_last_year": lambda x, r: f"{r['market']}'s imports of it from everyone grew {times(x)}" if x >= 1.2 else None,
    "market_imports_vs_3_years_ago": lambda x, r: f"{r['market']}'s imports of it are {times(x)} what they were 3 years before" if x >= 1.4 else None,
    "import_growth_vs_market_growth": lambda x, r: f"imports from {r['exporter']} grew {times(x)} faster than {r['market']}'s imports of it" if x >= 1.3 else None,
    "market_duties_in_force_on_product_against_others": lambda x, r: f"{r['market']} has duties in force on it against {count(x, 'other country', 'other countries')}, so trade can shift to {r['exporter']}" if x >= 1 else None,
    "market_duties_in_force_on_heading_against_others": lambda x, r: f"{r['market']} has duties in force on related products (HS {r['hs6'][:4]}) against {count(x, 'other country', 'other countries')}" if x >= 1 else None,
    "import_value_usd": lambda x, r: f"{r['exporter']} sells ${x / 1e6:,.0f}M of it a year to {r['market']}",
    "market_import_value_usd": lambda x, r: f"{r['market']} imports ${x / 1e6:,.0f}M of it a year",
    "exporter_rank_in_market": lambda x, r: f"{r['exporter']} is {r['market']}'s number {x:.0f} supplier of it" if x <= 3 else None,
    "market_supplier_count": lambda x, r: f"{x:.0f} countries supply it to {r['market']}",
    "exporter_world_exports_vs_last_year": lambda x, r: f"{r['exporter']}'s exports of it to the world grew {times(x)}" if x >= 1.3 else None,
    "exporter_share_of_world_exports": lambda x, r: f"{r['exporter']} makes {x:.0%} of the world's exports of it" if x >= 0.1 else None,
    "hs_chapter": lambda x, r: f"products of HS chapter {x:.0f} draw many cases",
    "past_cases_same_market_exporter_product": lambda x, r: f"{r['market']} has opened {count(x, 'case')} against {r['exporter']} on it before" if x >= 1 else None,
    "years_since_last_case_same_market_exporter_product": lambda x, r: (
        f"{r['market']} opened a case against {r['exporter']} on it "
        + ("this year" if x == 0 else "last year" if x == 1 else f"{x:.0f} years ago")) if x == x else None,
    "measure_in_force_same_market_exporter_product": lambda x, r: f"a duty from an earlier case is in force" if x >= 1 else None,
    "market_cases_on_product_last_5y": lambda x, r: f"{r['market']} opened {count(x, 'case')} on it in the last 5 years" if x >= 1 else None,
    "market_cases_on_heading_last_2y": lambda x, r: f"{r['market']} opened {count(x, 'case')} on related products (HS {r['hs6'][:4]}) in the last 2 years" if x >= 1 else None,
    "other_exporters_cased_on_product_last_2y": lambda x, r: f"{r['market']} opened cases on it against {count(x, 'other country', 'other countries')} in the last 2 years" if x >= 1 else None,
    "other_markets_casing_exporter_last_2y": lambda x, r: f"{count(x, 'other market')} opened cases against {r['exporter']} on it in the last 2 years" if x >= 1 else None,
    "market_cases_against_exporter_last_5y": lambda x, r: f"{r['market']} opened {count(x, 'case')} against {r['exporter']} in the last 5 years" if x >= 1 else None,
    "cases_on_product_all_markets_last_2y": lambda x, r: f"{count(x, 'case')} on it worldwide in the last 2 years" if x >= 1 else None,
    "cases_against_exporter_all_markets_last_5y": lambda x, r: f"{count(x, 'case')} against {r['exporter']} worldwide in the last 5 years" if x >= 1 else None,
    "market_cases_opened_this_year": lambda x, r: f"{r['market']} opened {count(x, 'case')} this year, on any product" if x >= 1 else None,
    "market_cases_opened_last_3y": lambda x, r: f"{r['market']} opened {count(x, 'case')} in the last 3 years" if x >= 1 else None,
}


def reasons(rows: pd.DataFrame, contributions: np.ndarray, features: list[str], limit: int = 3) -> list[list[str]]:
    """For each row, up to `limit` sentences for the features that raised its score the most."""
    result = []
    for position, (_, row) in enumerate(rows.iterrows()):
        order = np.argsort(-contributions[position])
        sentences = []
        for index in order:
            if contributions[position, index] <= 0 or len(sentences) == limit:
                break
            text = REASON_TEXT.get(features[index], lambda x, r: None)(row[features[index]], row)
            if text:
                sentences.append(text)
        result.append(sentences)
    return result


def similar_cases(cases: pd.DataFrame, market: str, exporter: str, hs6: str, before_year: int, limit: int = 3) -> pd.DataFrame:
    """The closest earlier cases: this market's cases on the product against this exporter first, then
    against others, then other markets' cases on it (against this exporter first), then related
    products (same heading) in this market; the most recent first within each."""
    earlier = cases[cases["year"] <= before_year]
    same_market, same_exporter = earlier["market"] == market, earlier["exporter"] == exporter
    same_product = earlier["hs6"] == hs6
    tiers = [
        earlier[same_market & same_exporter & same_product],
        earlier[same_market & same_product],
        earlier[~same_market & same_exporter & same_product],
        earlier[~same_market & same_product],
        earlier[same_market & (earlier["hs6"].str[:4] == hs6[:4])],
    ]
    found = pd.concat([t.assign(tier=i) for i, t in enumerate(tiers)]).drop_duplicates("case_id")
    found = found.sort_values(["tier", "opened_on"], ascending=[True, False]).head(limit)
    outcome = np.where(found["final_measure_on"].notna(), "duty imposed", np.where(found["year"] >= before_year - 1, "pending", "no duty"))
    return found.assign(outcome=outcome)[["case_id", "kind", "market", "exporter", "hs6", "year", "product", "outcome", "duty_pct"]]
