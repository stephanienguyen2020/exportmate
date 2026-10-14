import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database.models import SupplierDocument, SupplierDocumentUpload


def add_supplier_document_upload(
    db: Session, upload: SupplierDocumentUpload
) -> SupplierDocumentUpload:
    db.add(upload)
    db.flush()
    return upload


def get_company_supplier_document_upload(
    db: Session, company_id: uuid.UUID, upload_id: uuid.UUID
) -> SupplierDocumentUpload | None:
    return db.scalar(
        select(SupplierDocumentUpload)
        .where(
            SupplierDocumentUpload.id == upload_id,
            SupplierDocumentUpload.company_id == company_id,
        )
        .with_for_update()
    )


def get_supplier_document(db: Session, document_id: uuid.UUID) -> SupplierDocument | None:
    return db.get(SupplierDocument, document_id)
