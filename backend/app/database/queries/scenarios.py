"""What-ifs saved from the trade map."""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database.models import OrderScenario, ScenarioKind


def list_company_scenarios(
    db: Session, company_id: uuid.UUID, order_id: uuid.UUID | None = None
) -> list[OrderScenario]:
    """Newest change first; one order's when `order_id` is given."""
    query = select(OrderScenario).where(OrderScenario.company_id == company_id)
    if order_id is not None:
        query = query.where(OrderScenario.order_id == order_id)
    return list(db.scalars(query.order_by(OrderScenario.updated_at.desc())))


def get_company_scenario(
    db: Session, company_id: uuid.UUID, scenario_id: uuid.UUID
) -> OrderScenario | None:
    return db.scalar(
        select(OrderScenario).where(
            OrderScenario.company_id == company_id, OrderScenario.id == scenario_id
        )
    )


def get_scenario_by_target(
    db: Session, company_id: uuid.UUID, order_id: uuid.UUID, kind: ScenarioKind, target: str
) -> OrderScenario | None:
    return db.scalar(
        select(OrderScenario).where(
            OrderScenario.company_id == company_id,
            OrderScenario.order_id == order_id,
            OrderScenario.kind == kind,
            OrderScenario.target == target,
        )
    )


def add_scenario(db: Session, scenario: OrderScenario) -> OrderScenario:
    db.add(scenario)
    db.flush()
    return scenario


def delete_scenario(db: Session, scenario: OrderScenario) -> None:
    db.delete(scenario)
    db.flush()
