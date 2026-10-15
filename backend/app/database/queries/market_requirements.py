"""Market requirements by regulation version: drafting, review and replacement."""

import uuid

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.database.models import MarketRequirement, RegulationDocument, RequirementStatus


def list_document_requirements(db: Session, document_id: uuid.UUID) -> list[MarketRequirement]:
    return list(
        db.scalars(
            select(MarketRequirement)
            .where(MarketRequirement.regulation_document_id == document_id)
            .order_by(
                MarketRequirement.market_code,
                MarketRequirement.sort_order,
                MarketRequirement.requirement_key,
            )
        )
    )


def get_company_market_requirement(
    db: Session, company_id: uuid.UUID, requirement_id: uuid.UUID
) -> MarketRequirement | None:
    """One of the company's own requirements, locked for the review."""
    return db.scalar(
        select(MarketRequirement)
        .where(MarketRequirement.id == requirement_id, MarketRequirement.company_id == company_id)
        .with_for_update()
    )


def delete_document_drafts(db: Session, document_id: uuid.UUID) -> None:
    db.execute(
        delete(MarketRequirement).where(
            MarketRequirement.regulation_document_id == document_id,
            MarketRequirement.status == RequirementStatus.draft,
        )
    )


def count_document_requirements_by_status(
    db: Session, document_id: uuid.UUID
) -> dict[RequirementStatus, int]:
    rows = db.execute(
        select(MarketRequirement.status, func.count())
        .where(MarketRequirement.regulation_document_id == document_id)
        .group_by(MarketRequirement.status)
    ).all()
    return {status: count for status, count in rows}


def add_market_requirements(db: Session, requirements: list[MarketRequirement]) -> None:
    db.add_all(requirements)
    db.flush()


def replace_earlier_version_requirements(
    db: Session, regulation_id: uuid.UUID, version_number: int
) -> int:
    """Mark the reviewed requirements of every earlier version of the regulation `replaced`.
    Returns how many changed."""
    earlier = select(RegulationDocument.id).where(
        RegulationDocument.regulation_id == regulation_id,
        RegulationDocument.version_number < version_number,
    )
    result = db.execute(
        update(MarketRequirement)
        .where(
            MarketRequirement.regulation_document_id.in_(earlier),
            MarketRequirement.status == RequirementStatus.reviewed,
        )
        .values(status=RequirementStatus.replaced)
    )
    return result.rowcount


def get_regulation_version(
    db: Session, regulation_id: uuid.UUID, version_number: int
) -> RegulationDocument | None:
    return db.scalar(
        select(RegulationDocument).where(
            RegulationDocument.regulation_id == regulation_id,
            RegulationDocument.version_number == version_number,
        )
    )
