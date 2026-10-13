import uuid
from datetime import datetime

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.database.models import Import, ImportRow, ImportStatus


def create_import_with_rows(db: Session, item: Import, rows: list[ImportRow]) -> Import:
    db.add(item)
    db.flush()
    for row in rows:
        row.import_id = item.id
    db.add_all(rows)
    db.flush()
    return item


def get_import(
    db: Session, company_id: uuid.UUID, import_id: uuid.UUID, *, for_update: bool = False
) -> Import | None:
    stmt = select(Import).where(Import.id == import_id, Import.company_id == company_id)
    if for_update:
        stmt = stmt.with_for_update()
    return db.scalar(stmt)


def list_import_rows(db: Session, import_id: uuid.UUID) -> list[ImportRow]:
    return list(
        db.scalars(
            select(ImportRow).where(ImportRow.import_id == import_id).order_by(ImportRow.row_number)
        )
    )


def delete_uncommitted_imports_before(db: Session, cutoff: datetime) -> int:
    """Deletes imports never committed (their rows go with them). Returns how many."""
    result = db.execute(
        delete(Import).where(Import.status != ImportStatus.committed, Import.created_at < cutoff)
    )
    return result.rowcount


def find_committed_import_by_checksum(
    db: Session, company_id: uuid.UUID, checksum: str
) -> Import | None:
    return db.scalar(
        select(Import)
        .where(
            Import.company_id == company_id,
            Import.checksum == checksum,
            Import.status == ImportStatus.committed,
        )
        .order_by(Import.committed_at)
        .limit(1)
    )
