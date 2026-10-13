import uuid

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.orm import Session

from app.database.models import Regulation, RegulationDocument


def add_regulation(db: Session, regulation: Regulation) -> Regulation:
    db.add(regulation)
    db.flush()
    return regulation


def get_regulation(
    db: Session, company_id: uuid.UUID, regulation_id: uuid.UUID, *, for_update: bool = False
) -> Regulation | None:
    stmt = select(Regulation).where(
        Regulation.id == regulation_id, Regulation.company_id == company_id
    )
    if for_update:
        stmt = stmt.with_for_update()
    return db.scalar(stmt)


def find_regulation_by_official_id(
    db: Session, company_id: uuid.UUID, official_id: str
) -> Regulation | None:
    return db.scalar(
        select(Regulation).where(
            Regulation.company_id == company_id, Regulation.official_id == official_id
        )
    )


def list_regulations(
    db: Session, company_id: uuid.UUID, *, official_id: str | None = None
) -> list[Regulation]:
    stmt = select(Regulation).where(Regulation.company_id == company_id)
    if official_id:
        stmt = stmt.where(Regulation.official_id == official_id)
    return list(db.scalars(stmt.order_by(Regulation.created_at, Regulation.id)))


def summarize_versions_by_regulation(
    db: Session, regulation_ids: list[uuid.UUID]
) -> dict[uuid.UUID, tuple[int, RegulationDocument]]:
    """{regulation_id: (version_count, latest_version)} for each regulation with versions."""
    if not regulation_ids:
        return {}
    rows = db.execute(
        select(RegulationDocument, func.count().over(partition_by=RegulationDocument.regulation_id))
        .where(RegulationDocument.regulation_id.in_(regulation_ids))
        .order_by(RegulationDocument.regulation_id, RegulationDocument.version_number.desc())
        .ext(distinct_on(RegulationDocument.regulation_id))
    ).all()
    return {document.regulation_id: (count, document) for document, count in rows}


def get_latest_version_number(db: Session, regulation_id: uuid.UUID) -> int:
    return db.scalar(
        select(func.coalesce(func.max(RegulationDocument.version_number), 0)).where(
            RegulationDocument.regulation_id == regulation_id
        )
    )


def list_regulation_versions(db: Session, regulation_id: uuid.UUID) -> list[RegulationDocument]:
    return list(
        db.scalars(
            select(RegulationDocument)
            .where(RegulationDocument.regulation_id == regulation_id)
            .order_by(RegulationDocument.version_number.desc())
        )
    )


def add_regulation_document(db: Session, document: RegulationDocument) -> RegulationDocument:
    db.add(document)
    db.flush()
    return document


def get_regulation_document(
    db: Session, company_id: uuid.UUID, document_id: uuid.UUID
) -> RegulationDocument | None:
    return db.scalar(
        select(RegulationDocument).where(
            RegulationDocument.id == document_id, RegulationDocument.company_id == company_id
        )
    )


def find_regulation_document_by_checksum(
    db: Session, company_id: uuid.UUID, checksum: str
) -> RegulationDocument | None:
    return db.scalar(
        select(RegulationDocument).where(
            RegulationDocument.company_id == company_id, RegulationDocument.checksum == checksum
        )
    )
