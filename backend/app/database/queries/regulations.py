import uuid

from sqlalchemy import func, or_, select
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.orm import Session

from app.database.models import Regulation, RegulationDocument


def _is_shared_or_owned_by_company(company_id: uuid.UUID):
    """Filter: the regulation is shared (company_id null) or belongs to this company."""
    return or_(Regulation.company_id == company_id, Regulation.company_id.is_(None))


def add_regulation(db: Session, regulation: Regulation) -> Regulation:
    db.add(regulation)
    db.flush()
    return regulation


def get_company_regulation(
    db: Session, company_id: uuid.UUID, regulation_id: uuid.UUID, *, for_update: bool = False
) -> Regulation | None:
    """One of the company's own regulations (not a shared one)."""
    stmt = select(Regulation).where(
        Regulation.id == regulation_id, Regulation.company_id == company_id
    )
    if for_update:
        stmt = stmt.with_for_update()
    return db.scalar(stmt)


def get_shared_or_company_regulation(
    db: Session, company_id: uuid.UUID, regulation_id: uuid.UUID
) -> Regulation | None:
    return db.scalar(
        select(Regulation).where(
            Regulation.id == regulation_id, _is_shared_or_owned_by_company(company_id)
        )
    )


def get_shared_regulation_by_official_id(db: Session, official_id: str) -> Regulation | None:
    return db.scalar(
        select(Regulation).where(
            Regulation.company_id.is_(None), Regulation.official_id == official_id
        )
    )


def get_company_regulation_by_official_id(
    db: Session, company_id: uuid.UUID, official_id: str
) -> Regulation | None:
    return db.scalar(
        select(Regulation).where(
            Regulation.company_id == company_id, Regulation.official_id == official_id
        )
    )


def list_shared_and_company_regulations(
    db: Session, company_id: uuid.UUID, *, official_id: str | None = None
) -> list[Regulation]:
    stmt = select(Regulation).where(_is_shared_or_owned_by_company(company_id))
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


def get_shared_or_company_regulation_document(
    db: Session, company_id: uuid.UUID, document_id: uuid.UUID
) -> RegulationDocument | None:
    return db.scalar(
        select(RegulationDocument)
        .join(Regulation, RegulationDocument.regulation_id == Regulation.id)
        .where(RegulationDocument.id == document_id, _is_shared_or_owned_by_company(company_id))
    )


def get_regulation_document_by_source_url(
    db: Session, regulation_id: uuid.UUID, source_url: str
) -> RegulationDocument | None:
    return db.scalar(
        select(RegulationDocument).where(
            RegulationDocument.regulation_id == regulation_id,
            RegulationDocument.source_url == source_url,
        )
    )


def list_documents_with_regulations(
    db: Session, document_ids: list[uuid.UUID]
) -> list[tuple[RegulationDocument, Regulation]]:
    if not document_ids:
        return []
    rows = db.execute(
        select(RegulationDocument, Regulation)
        .join(Regulation, RegulationDocument.regulation_id == Regulation.id)
        .where(RegulationDocument.id.in_(document_ids))
    ).all()
    return [(document, regulation) for document, regulation in rows]


def get_regulation_document_by_checksum(
    db: Session, regulation_id: uuid.UUID, checksum: str
) -> RegulationDocument | None:
    return db.scalar(
        select(RegulationDocument).where(
            RegulationDocument.regulation_id == regulation_id,
            RegulationDocument.checksum == checksum,
        )
    )
