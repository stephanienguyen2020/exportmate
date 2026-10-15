"""CSV import: upload → validate → preview → commit (all-or-nothing)."""

import hashlib
import logging
import uuid
from datetime import UTC, date, datetime, timedelta
from pathlib import PurePath

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.context import CompanyContext
from app.core.errors import AppError, not_found_error
from app.database.models import Import, ImportRow, ImportStatus, Order, OrderStatus
from app.database.queries import audit as audit_queries
from app.database.queries import imports as import_queries
from app.database.queries import orders as order_queries
from app.schemas.imports import CommitOut, ImportOut, PreviewRowOut
from app.services import analysis as analysis_service
from app.services.order_csv import parse_order_csv, reject_existing_order_ids

PREVIEW_LIMIT = 200

log = logging.getLogger(__name__)


def _to_json_fields(order: dict) -> dict:
    return {**order, "ship_date": order["ship_date"].isoformat()}


def _preview_rows(rows: list[ImportRow]) -> list[PreviewRowOut]:
    preview = []
    for row in rows:
        if row.order_fields is None:
            continue
        fields = row.order_fields
        preview.append(
            PreviewRowOut(
                row_number=row.row_number,
                id=fields["external_id"],
                product=fields["product"],
                supplier=fields["supplier"],
                destination=fields["destination"],
                value_minor=fields["value_minor"],
                currency=fields["currency"],
                ship_date=date.fromisoformat(fields["ship_date"]),
                hs_code=fields["hs_code"],
            )
        )
        if len(preview) == PREVIEW_LIMIT:
            break
    return preview


def build_import_response(db: Session, item: Import) -> ImportOut:
    duplicate = import_queries.find_committed_import_by_checksum(db, item.company_id, item.checksum)
    return ImportOut(
        id=item.id,
        filename=item.filename,
        status=item.status,
        row_count=item.row_count,
        errors=item.errors,
        preview=_preview_rows(import_queries.list_import_rows(db, item.id)),
        duplicate_of_import_id=duplicate.id if duplicate and duplicate.id != item.id else None,
        created_at=item.created_at,
        committed_at=item.committed_at,
    )


def upload_order_csv(db: Session, ctx: CompanyContext, filename: str, content: bytes) -> Import:
    settings = get_settings()
    if PurePath(filename).suffix.lower() != ".csv":
        raise AppError(422, "invalid_file_type", "Upload a .csv file.", {"file": "Must be .csv"})
    if len(content) > settings.max_upload_bytes:
        limit_mb = settings.max_upload_bytes // (1024 * 1024)
        raise AppError(422, "file_too_large", f"The file is larger than {limit_mb} MB.")
    if not content:
        raise AppError(422, "empty_file", "The file is empty.")

    parsed = parse_order_csv(
        content, default_currency=ctx.company.currency, max_rows=settings.max_import_rows
    )
    order_ids = [r.order["external_id"] for r in parsed.valid_rows]
    existing = order_queries.find_existing_external_ids(db, ctx.company_id, order_ids)
    reject_existing_order_ids(parsed, existing)

    item = Import(
        company_id=ctx.company_id,
        filename=PurePath(filename).name[:255],
        checksum=hashlib.sha256(content).hexdigest(),
        size_bytes=len(content),
        content=content,
        status=ImportStatus.invalid if parsed.errors else ImportStatus.validated,
        row_count=len(parsed.rows),
        errors=[e.as_dict() for e in parsed.errors],
        created_by=ctx.user.id,
    )
    rows = [
        ImportRow(
            row_number=r.row_number,
            raw=r.raw,
            row_hash=r.row_hash,
            order_fields=_to_json_fields(r.order) if r.order else None,
        )
        for r in parsed.rows
    ]
    import_queries.create_import_with_rows(db, item, rows)
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action="import.uploaded",
        object_type="import",
        object_id=str(item.id),
        data={"filename": item.filename, "rows": item.row_count, "errors": len(item.errors)},
    )
    db.commit()
    log.info(
        "import.uploaded",
        extra={
            "company_id": str(ctx.company_id),
            "import_id": str(item.id),
            "status": item.status.value,
            "rows": item.row_count,
            "errors": len(item.errors),
            "size_bytes": item.size_bytes,
        },
    )
    return item


def delete_stale_imports(db: Session, older_than: timedelta) -> int:
    """Removes uploads nobody committed. Committed imports stay: orders cite their rows."""
    deleted = import_queries.delete_uncommitted_imports_before(db, datetime.now(UTC) - older_than)
    db.commit()
    log.info("import.stale_deleted", extra={"deleted": deleted, "older_than_days": older_than.days})
    return deleted


def get_order_import(db: Session, ctx: CompanyContext, import_id: uuid.UUID) -> Import:
    item = import_queries.get_import(db, ctx.company_id, import_id)
    if not item:
        raise not_found_error("Import")
    return item


def commit_order_import(db: Session, ctx: CompanyContext, import_id: uuid.UUID) -> CommitOut:
    # Lock the import row so two commits of the same file cannot both run.
    item = import_queries.get_import(db, ctx.company_id, import_id, for_update=True)
    if not item:
        raise not_found_error("Import")
    if item.status == ImportStatus.committed:
        raise AppError(409, "already_committed", "This import was already committed.")
    if item.status == ImportStatus.invalid:
        raise AppError(422, "import_has_errors", "Fix the errors and upload the file again.")

    rows = import_queries.list_import_rows(db, item.id)
    order_ids = [r.order_fields["external_id"] for r in rows]
    taken = order_queries.find_existing_external_ids(db, ctx.company_id, order_ids)
    if taken:
        raise AppError(
            409,
            "orders_already_exist",
            f"These orders were added since validation: {', '.join(sorted(taken))}.",
        )

    orders = [
        Order(
            company_id=ctx.company_id,
            external_id=r.order_fields["external_id"],
            product=r.order_fields["product"],
            supplier=r.order_fields["supplier"],
            destination=r.order_fields["destination"],
            value_minor=r.order_fields["value_minor"],
            currency=r.order_fields["currency"],
            ship_date=date.fromisoformat(r.order_fields["ship_date"]),
            hs_code=r.order_fields["hs_code"],
            status=OrderStatus.awaiting_analysis,
            source_row_id=r.id,
        )
        for r in rows
    ]
    try:
        order_queries.add_orders(db, orders)
    except IntegrityError:
        db.rollback()
        log.warning(
            "import.commit_conflict",
            extra={"company_id": str(ctx.company_id), "import_id": str(import_id)},
        )
        raise AppError(409, "orders_already_exist", "Some orders were added at the same time.")

    item.status = ImportStatus.committed
    item.committed_at = datetime.now(UTC)
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action="import.committed",
        object_type="import",
        object_id=str(item.id),
        data={"ordersCreated": len(orders)},
    )
    db.commit()
    log.info(
        "import.committed",
        extra={
            "company_id": str(ctx.company_id),
            "import_id": str(item.id),
            "orders_created": len(orders),
        },
    )
    # Analyse the new orders straight away. The orders are already saved: if the run fails,
    # it is recorded as failed and the orders wait for "Analyse orders".
    try:
        run = analysis_service.start_run(db, ctx, [o.external_id for o in orders])
    except AppError:
        run = None
    return CommitOut(import_id=item.id, orders_created=len(orders), run=run)
