"""Trade defence risk of an order's market, the company's country and the order's product.

Reads only what the Order features job saved (`trade_risk_scores`, `trade_flow_features`,
`trade_cases`); it never calls Comtrade or the model. Each order's pair is kept in
`order_trade_pairs` (saved with the order), so the job scores it before anyone asks; a pair with no
score yet starts the job (core/trade_risk_job.py) and answers `pending`. Scores and reasons only, never the trade
figures (UN Comtrade's terms). Design: ml/docs/TRADE_DEFENCE_RISK_MODEL.md ("Online path").
"""

import logging
import re
from collections.abc import Callable

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core import clock
from app.core.auth import CompanyContext
from app.core.errors import AppError, not_found_error
from app.core.trade_risk_job import start_new_order_pairs, start_pairs
from app.database.models import Order, TradeCase
from app.database.queries import orders as order_queries
from app.database.queries import trade_map as map_queries
from app.database.queries import trade_risk as risk_queries
from app.schemas.trade_risk import SimilarTradeCaseOut, TradeRiskOut, TradeRiskReasonOut
from app.services.trade_map import Gazetteer, load_gazetteer, locate_destination, parse_destination

log = logging.getLogger(__name__)

# Customs unions open cases for all their members: their members' imports are one market.
CUSTOMS_UNIONS = {
    "EU": frozenset(
        [
            "AT",
            "BE",
            "BG",
            "HR",
            "CY",
            "CZ",
            "DK",
            "EE",
            "FI",
            "FR",
            "DE",
            "GR",
            "HU",
            "IE",
            "IT",
            "LV",
            "LT",
            "LU",
            "MT",
            "NL",
            "PL",
            "PT",
            "RO",
            "SK",
            "SI",
            "ES",
            "SE",
        ]
    ),
    "EAEU": frozenset(["RU", "KZ", "BY", "AM", "KG"]),
    "GCC": frozenset(["SA", "AE", "KW", "QA", "BH", "OM"]),
}
SIMILAR_CASE_LIMIT = 3
SOURCES = [
    "Source: UN Comtrade",
    "CEPII BACI",
    "World Bank Temporary Trade Barriers Database (Bown, Cieszkowsky, Erbahar, Signoret 2020)",
    "US Federal Register",
]


def trade_market(country_alpha2: str) -> str:
    """The market a destination country belongs to for trade defence: its customs union, or itself."""
    code = country_alpha2.upper()
    return next((union for union, members in CUSTOMS_UNIONS.items() if code in members), code)


def hs6_of(hs_code: str) -> str | None:
    digits = re.sub(r"\D", "", hs_code)
    return digits[:6] if len(digits) >= 6 else None


def company_country(db: Session, ctx: CompanyContext) -> str | None:
    """The exporting country: the route-origin site's, else any site's, else the profile's origin."""
    sites = map_queries.list_company_sites(db, ctx.company.id)  # route origin first
    for site in sites:
        if site.country_alpha2:
            return site.country_alpha2
    origin = (ctx.company.origin or "").strip().lower()
    for country in map_queries.list_countries(db):
        if origin in (country.name.lower(), country.alpha2.lower()):
            return country.alpha2
    return None


def outcome_of(case: TradeCase, this_year: int) -> str:
    if case.final_measure_on is not None:
        return "duty imposed"
    return "pending" if case.opened_on.year >= this_year - 1 else "no duty"


def similar_cases(
    cases: list[TradeCase], market: str, exporter: str, model_hs6: str, this_year: int
) -> list[SimilarTradeCaseOut]:
    """The closest earlier cases: this market's on the product against this exporter, then
    against others; other markets' on it (this exporter first); then related products in this
    market. Newest first within each; one row per case."""

    def tier(case: TradeCase) -> int:
        same_market, same_exporter = case.market == market, case.exporter == exporter
        if case.hs6 == model_hs6:
            if same_market:
                return 0 if same_exporter else 1
            return 2 if same_exporter else 3
        return 4

    ranked = sorted(cases, key=lambda c: (tier(c), -c.opened_on.toordinal()))
    result, seen = [], set()
    for case in ranked:
        if case.case_id in seen:
            continue
        seen.add(case.case_id)
        result.append(
            SimilarTradeCaseOut(
                case_id=case.case_id,
                kind=case.kind,
                market=case.market,
                exporter=case.exporter,
                hs6=case.hs6,
                year=case.opened_on.year,
                product=case.product,
                outcome=outcome_of(case, this_year),
                duty_pct=case.duty_pct,
            )
        )
        if len(result) == SIMILAR_CASE_LIMIT:
            break
    return result


def pair_risk(
    db: Session,
    destination: str,
    exporter: str | None,
    hs_code: str,
    start_backfill: Callable[[str], bool],
) -> TradeRiskOut:
    """The risk for a destination country, exporting country and HS code. `start_backfill` gets
    the job's pair argument when there is no score yet."""
    hs6 = hs6_of(hs_code)
    market = trade_market(destination) if destination else None
    base = {"market": market, "exporter": exporter, "hs6": hs6, "sources": SOURCES}
    if not market:
        return TradeRiskOut(**base, status="no_data", note="The destination country isn't known.")
    if not exporter:
        return TradeRiskOut(
            **base,
            status="no_data",
            note="The company's country isn't known: add a site with its country on the trade map.",
        )
    if not hs6:
        return TradeRiskOut(
            **base, status="no_data", note="The HS code needs at least 6 digits to score."
        )
    score = risk_queries.get_latest_trade_risk_score(db, market, exporter, hs6)
    if score is None:
        started = start_backfill(pair_argument(destination.upper(), exporter, hs6))
        return TradeRiskOut(**base, status="pending", backfill_started=started)
    cases = []
    if score.model_hs6:
        candidates = risk_queries.list_cases_near_product(db, market, exporter, score.model_hs6)
        cases = similar_cases(candidates, market, exporter, score.model_hs6, clock.today().year)
    scored = score.level != "no_data"
    return TradeRiskOut(
        **base,
        status="scored" if scored else "no_data",
        level=score.level if scored else None,
        score=score.score,
        percentile=score.percentile,
        reasons=[
            TradeRiskReasonOut(feature=r["feature"], text=r["text"]) for r in score.reasons or []
        ],
        note=score.note,
        model_version=score.model_version,
        data_from=score.data_from,
        data_to=score.data_to,
        data_source=score.data_source,
        scored_at=score.scored_at,
        similar_cases=cases,
    )


def pair_argument(destination: str, exporter: str, hs6: str) -> str:
    """What the job's --pair takes: destination country, exporting country, HS code."""
    return f"{destination}:{exporter}:{hs6}"


def order_pair(order: Order, gazetteer: Gazetteer, exporter: str | None) -> tuple | None:
    """(destination country, market, exporter, hs6) of an order, or None when one is unknown."""
    country = locate_destination(order.destination, gazetteer).country
    hs6 = hs6_of(order.hs_code)
    if not (country and exporter and hs6):
        return None
    return country, trade_market(country), exporter, hs6


def record_order_pairs(db: Session, ctx: CompanyContext, orders: list[Order]) -> None:
    """Keep each order's pair in order_trade_pairs and start the job for pairs with no score.
    Called after the orders are committed; a failure here never undoes saving them."""
    try:
        gazetteer, exporter = load_gazetteer(db), company_country(db, ctx)
        unscored = set()
        for order in orders:
            pair = order_pair(order, gazetteer, exporter)
            if pair is None:
                risk_queries.delete_order_trade_pair(db, order.id)
                continue
            _, market, exporter_code, hs6 = pair
            risk_queries.save_order_trade_pair(db, order.id, market, exporter_code, hs6)
            if risk_queries.get_latest_trade_risk_score(db, market, exporter_code, hs6) is None:
                unscored.add(pair_argument(market, exporter_code, hs6))
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        log.exception("trade_risk.order_pairs_failed", extra={"company_id": str(ctx.company_id)})
        return
    if unscored:
        start_new_order_pairs(sorted(unscored))


def order_risk(db: Session, ctx: CompanyContext, order_id: str) -> TradeRiskOut:
    order = order_queries.get_order_by_external_id(db, ctx.company.id, order_id)
    if order is None:
        raise not_found_error("Order")
    pair = order_pair(order, load_gazetteer(db), company_country(db, ctx))
    saved = risk_queries.get_order_trade_pair(db, order.id)
    if pair and (saved is None or (saved.market, saved.exporter, saved.hs6) != pair[1:]):
        # An order from before trade risk, or whose company country changed since it was saved.
        record_order_pairs(db, ctx, [order])
    country = pair[0] if pair else ""
    exporter = pair[2] if pair else company_country(db, ctx)

    def start_backfill(_: str) -> bool:
        return start_new_order_pairs([pair_argument(*pair[1:])])

    risk = pair_risk(db, country, exporter, order.hs_code, start_backfill)
    return risk.model_copy(update={"order_id": order.external_id})


def market_risk(
    db: Session, ctx: CompanyContext, destination: str, hs_code: str, exporter: str | None
) -> TradeRiskOut:
    """For a what-if or the assistant: any destination, the company's country unless given."""
    _, country = parse_destination(destination)
    if not country:
        raise AppError(422, "bad_destination", "Give the destination as a country code, e.g. US.")
    exporter = (exporter or "").upper() or company_country(db, ctx)
    return pair_risk(db, country, exporter, hs_code, lambda pair: start_pairs([pair]))
