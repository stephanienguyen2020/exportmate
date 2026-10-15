"""A company's suppliers and the documents each one has on file, entered in the trade map.

Orders match a supplier by its name key (trimmed, single-spaced, lower-case), so renaming a
supplier moves which orders it is checked against. Deleting one leaves its orders in place,
named on the order but without a record (their supplier checks become "unknown").
"""

import logging
import uuid
from collections.abc import Callable

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.context import CompanyContext
from app.core.errors import AppError, not_found_error
from app.database.models import Supplier, SupplierDocument
from app.database.queries import audit as audit_queries
from app.database.queries import trade_map as map_queries
from app.schemas.trade_map import (
    GeoPoint,
    SupplierDocumentIn,
    SupplierIn,
    SupplierOut,
    SupplierUpdate,
)
from app.services.trade_map import supplier_documents_out, supplier_name_key

log = logging.getLogger(__name__)


def _supplier_exists_error() -> AppError:
    return AppError(
        409,
        "supplier_exists",
        "You already have a supplier with this name.",
        {"name": "Already in your supplier list"},
    )


def _check_country(db: Session, code: str | None) -> None:
    if code is not None and not map_queries.get_country(db, code):
        raise AppError(
            422,
            "invalid_input",
            "Some fields are invalid.",
            {"country": "Not a country on the map"},
        )


def _check_document_kinds(db: Session, documents: list[SupplierDocumentIn]) -> None:
    known = {k.kind for k in map_queries.list_document_kinds(db)}
    unknown = sorted({d.kind for d in documents} - known)
    if unknown:
        raise AppError(
            422,
            "invalid_input",
            "Some fields are invalid.",
            {"documents": f"Unknown document kind: {', '.join(unknown)}"},
        )


def _supplier_out(db: Session, supplier: Supplier) -> SupplierOut:
    kinds = {k.kind: k.label for k in map_queries.list_document_kinds(db)}
    documents = map_queries.list_supplier_documents(db, [supplier.id])
    location = (
        GeoPoint(latitude=supplier.latitude, longitude=supplier.longitude)
        if supplier.latitude is not None and supplier.longitude is not None
        else None
    )
    return SupplierOut(
        id=supplier.id,
        name=supplier.name,
        place=supplier.place,
        country=supplier.country_alpha2,
        location=location,
        supplies=supplier.supplies,
        contact_name=supplier.contact_name,
        contact_email=supplier.contact_email,
        documents=supplier_documents_out(documents, kinds),
    )


def _save_documents(
    db: Session, supplier_id: uuid.UUID, documents: list[SupplierDocumentIn]
) -> None:
    """Replace the list. A kind that stays keeps the upload it was confirmed from, so editing a
    supplier never loses the link to the certificate file."""
    uploads = {d.kind: d.upload_id for d in map_queries.list_supplier_documents(db, [supplier_id])}
    map_queries.replace_supplier_documents(
        db,
        supplier_id,
        [
            SupplierDocument(
                supplier_id=supplier_id,
                kind=d.kind,
                detail=d.detail,
                standards=d.standards,
                document_number=d.document_number,
                issuer=d.issuer,
                expires_on=d.expires_on,
                upload_id=uploads.get(d.kind),
            )
            for d in documents
        ],
    )


def _flush_name(db: Session, write: Callable[[], object]) -> None:
    """Two editors saving the same name at once: the unique key catches the second."""
    try:
        write()
    except IntegrityError:
        db.rollback()
        raise _supplier_exists_error() from None


def _record_change(db: Session, ctx: CompanyContext, action: str, supplier: Supplier) -> None:
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action=action,
        object_type="supplier",
        object_id=str(supplier.id),
        data={"name": supplier.name},
    )
    db.commit()
    log.info(action, extra={"company_id": str(ctx.company_id), "supplier_id": str(supplier.id)})


def create_supplier(db: Session, ctx: CompanyContext, payload: SupplierIn) -> SupplierOut:
    name = " ".join(payload.name.split())
    key = supplier_name_key(name)
    if map_queries.get_supplier_by_name_key(db, ctx.company_id, key):
        raise _supplier_exists_error()
    _check_country(db, payload.country)
    _check_document_kinds(db, payload.documents)
    supplier = Supplier(
        company_id=ctx.company_id,
        name=name,
        name_key=key,
        place=payload.place,
        country_alpha2=payload.country,
        latitude=payload.location.latitude if payload.location else None,
        longitude=payload.location.longitude if payload.location else None,
        supplies=payload.supplies,
        contact_name=payload.contact_name,
        contact_email=payload.contact_email,
    )
    _flush_name(db, lambda: map_queries.add_supplier(db, supplier))
    _save_documents(db, supplier.id, payload.documents)
    _record_change(db, ctx, "supplier.created", supplier)
    return _supplier_out(db, supplier)


def update_supplier(
    db: Session, ctx: CompanyContext, supplier_id: uuid.UUID, payload: SupplierUpdate
) -> SupplierOut:
    supplier = map_queries.get_company_supplier(db, ctx.company_id, supplier_id)
    if not supplier:
        raise not_found_error("Supplier")
    sent = payload.model_fields_set
    if "name" in sent:
        name = " ".join(payload.name.split())
        key = supplier_name_key(name)
        other = map_queries.get_supplier_by_name_key(db, ctx.company_id, key)
        if other and other.id != supplier.id:
            raise _supplier_exists_error()
        supplier.name, supplier.name_key = name, key
    if "country" in sent:
        _check_country(db, payload.country)
        supplier.country_alpha2 = payload.country
    if "documents" in sent:
        _check_document_kinds(db, payload.documents)
        _save_documents(db, supplier.id, payload.documents)
    if "place" in sent:
        supplier.place = payload.place
    if "supplies" in sent:
        supplier.supplies = payload.supplies
    if "contact_name" in sent:
        supplier.contact_name = payload.contact_name
    if "contact_email" in sent:
        supplier.contact_email = payload.contact_email
    if "location" in sent:
        supplier.latitude = payload.location.latitude if payload.location else None
        supplier.longitude = payload.location.longitude if payload.location else None
    _flush_name(db, db.flush)
    _record_change(db, ctx, "supplier.updated", supplier)
    return _supplier_out(db, supplier)


def delete_supplier(db: Session, ctx: CompanyContext, supplier_id: uuid.UUID) -> None:
    supplier = map_queries.get_company_supplier(db, ctx.company_id, supplier_id)
    if not supplier:
        raise not_found_error("Supplier")
    map_queries.delete_supplier(db, supplier)
    _record_change(db, ctx, "supplier.deleted", supplier)
