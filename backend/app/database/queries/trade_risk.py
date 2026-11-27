"""The trade risk tables. The Order features job (ml/) writes all but `order_trade_pairs`,
which the backend keeps (one row per order)."""

import uuid

from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from app.database.models import OrderTradePair, TradeCase, TradeFlowFeatures, TradeRiskScore

SIMILAR_CASE_CANDIDATES = 200


def get_latest_trade_risk_score(
    db: Session, market: str, exporter: str, hs6: str
) -> TradeRiskScore | None:
    return db.scalar(
        select(TradeRiskScore)
        .where(
            TradeRiskScore.market == market,
            TradeRiskScore.exporter == exporter,
            TradeRiskScore.hs6 == hs6,
        )
        .order_by(TradeRiskScore.scored_at.desc())
        .limit(1)
    )


def get_trade_flow_features(
    db: Session, market: str, exporter: str, hs6: str
) -> TradeFlowFeatures | None:
    return db.get(TradeFlowFeatures, (market, exporter, hs6))


def list_cases_near_product(
    db: Session, market: str, exporter: str, model_hs6: str
) -> list[TradeCase]:
    """Cases on the product anywhere, and on related products (same heading) in the market: the
    pool the closest past cases are picked from, newest first."""
    return list(
        db.scalars(
            select(TradeCase)
            .where(
                or_(
                    TradeCase.hs6 == model_hs6,
                    (TradeCase.market == market) & TradeCase.hs6.startswith(model_hs6[:4]),
                )
            )
            .order_by(TradeCase.opened_on.desc())
            .limit(SIMILAR_CASE_CANDIDATES)
        )
    )


def get_order_trade_pair(db: Session, order_id: uuid.UUID) -> OrderTradePair | None:
    return db.get(OrderTradePair, order_id)


def save_order_trade_pair(
    db: Session, order_id: uuid.UUID, market: str, exporter: str, hs6: str
) -> None:
    db.merge(OrderTradePair(order_id=order_id, market=market, exporter=exporter, hs6=hs6))
    db.flush()


def delete_order_trade_pair(db: Session, order_id: uuid.UUID) -> None:
    db.execute(delete(OrderTradePair).where(OrderTradePair.order_id == order_id))
