"""Regulations and their documents (one uploaded file per version).

Every upload (an official text or an article) is a version of a regulation: either version 1
of a new regulation, or the next version of one the uploader picks.
"""

import hashlib
import logging
import uuid
from pathlib import PurePath
from urllib.parse import urlparse

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.context import CompanyContext
from app.core.errors import AppError, not_found_error
from app.core.file_storage import get_file_storage
from app.database.models import Regulation, RegulationDocument
from app.database.queries import audit as audit_queries
from app.database.queries import regulations as regulation_queries
from app.schemas.regulations import RegulationDetailOut, RegulationDocumentOut, RegulationOut

log = logging.getLogger(__name__)
CONTENT_TYPES = {
    ".pdf": "application/pdf",
    ".html": "text/html",
    ".htm": "text/html",
    ".txt": "text/plain",
}


def _clean_text(value: str | None) -> str | None:
    value = (value or "").strip()
    return value or None


def _check_file(filename: str, content: bytes) -> tuple[str, str]:
    """Return (suffix, content type) or raise a 422."""
    settings = get_settings()
    suffix = PurePath(filename).suffix.lower()
    if suffix not in CONTENT_TYPES:
        allowed = ", ".join(CONTENT_TYPES)
        raise AppError(
            422, "invalid_file_type", f"Upload one of: {allowed}.", {"file": f"Must be {allowed}"}
        )
    if len(content) > settings.max_upload_bytes:
        limit_mb = settings.max_upload_bytes // (1024 * 1024)
        raise AppError(422, "file_too_large", f"The file is larger than {limit_mb} MB.")
    if not content:
        raise AppError(422, "empty_file", "The file is empty.")
    if suffix == ".pdf" and not content.startswith(b"%PDF-"):
        raise AppError(422, "invalid_pdf", "This file is not a PDF.", {"file": "Not a PDF"})
    return suffix, CONTENT_TYPES[suffix]


def _check_source_url(source_url: str | None) -> None:
    if source_url is None:
        return
    parsed = urlparse(source_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or len(source_url) > 2000:
        raise AppError(
            422,
            "invalid_input",
            "Some fields are invalid.",
            {"sourceUrl": "Must be an http(s) link, at most 2000 characters"},
        )


def _create_regulation(
    db: Session, ctx: CompanyContext, title: str, official_id: str | None
) -> Regulation:
    if official_id:
        existing = regulation_queries.find_regulation_by_official_id(
            db, ctx.company_id, official_id
        )
        if existing:
            raise AppError(
                409,
                "regulation_exists",
                f"'{existing.title}' already has official ID {official_id}. "
                "Upload this file as a new version of it.",
                {"officialId": f"Already used by regulation {existing.id}"},
            )
    regulation = regulation_queries.add_regulation(
        db,
        Regulation(
            company_id=ctx.company_id,
            title=title,
            official_id=official_id,
            created_by=ctx.user.id,
        ),
    )
    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action="regulation.created",
        object_type="regulation",
        object_id=str(regulation.id),
        data={"title": title, "officialId": official_id},
    )
    return regulation


def _resolve_regulation(
    db: Session,
    ctx: CompanyContext,
    title: str,
    regulation_id: uuid.UUID | None,
    official_id: str | None,
) -> tuple[Regulation, int]:
    """Which regulation the file belongs to, and its version number."""
    if regulation_id is None:
        return _create_regulation(db, ctx, title, official_id), 1

    if official_id:
        raise AppError(
            422,
            "invalid_input",
            "Official ID is set when the regulation is created, not per version.",
            {"officialId": "Leave empty when uploading a new version"},
        )
    # Lock the regulation so two uploads at once cannot both become version N.
    regulation = regulation_queries.get_regulation(
        db, ctx.company_id, regulation_id, for_update=True
    )
    if not regulation:
        raise not_found_error("Regulation")
    return regulation, regulation_queries.get_latest_version_number(db, regulation.id) + 1


def upload_regulation_document(
    db: Session,
    ctx: CompanyContext,
    *,
    filename: str,
    content: bytes,
    title: str,
    source_url: str | None = None,
    regulation_id: uuid.UUID | None = None,
    official_id: str | None = None,
) -> RegulationDocument:
    suffix, content_type = _check_file(filename, content)
    clean_title = _clean_text(title)
    if not clean_title or len(clean_title) > 300:
        raise AppError(
            422, "invalid_input", "Some fields are invalid.", {"title": "1 to 300 characters"}
        )
    source_url = _clean_text(source_url)
    _check_source_url(source_url)
    official_id = _clean_text(official_id)
    if official_id and len(official_id) > 100:
        raise AppError(
            422,
            "invalid_input",
            "Some fields are invalid.",
            {"officialId": "At most 100 characters"},
        )

    checksum = hashlib.sha256(content).hexdigest()
    try:
        regulation, version_number = _resolve_regulation(
            db, ctx, clean_title, regulation_id, official_id
        )
        duplicate = regulation_queries.find_regulation_document_by_checksum(
            db, regulation.id, checksum
        )
        if duplicate:
            raise AppError(
                409,
                "already_uploaded",
                f"This file is already version {duplicate.version_number} of this regulation.",
            )
        document_id = uuid.uuid4()
        document = regulation_queries.add_regulation_document(
            db,
            RegulationDocument(
                id=document_id,
                title=clean_title,
                filename=PurePath(filename).name[:255],
                content_type=content_type,
                size_bytes=len(content),
                checksum=checksum,
                storage_path=f"companies/{ctx.company_id}/documents/{document_id}{suffix}",
                source_url=source_url,
                regulation_id=regulation.id,
                version_number=version_number,
                created_by=ctx.user.id,
            ),
        )
    except IntegrityError:
        # Same file or same official ID uploaded at the same moment.
        db.rollback()
        raise AppError(409, "already_uploaded", "This file or regulation was just uploaded.")

    audit_queries.record_audit_event(
        db,
        company_id=ctx.company_id,
        user_id=ctx.user.id,
        action="regulation_document.uploaded",
        object_type="regulation_document",
        object_id=str(document.id),
        data={
            "title": clean_title,
            "regulationId": str(regulation.id),
            "versionNumber": version_number,
        },
    )
    # Save the file before committing: a failed save rolls back the row; a failed commit only
    # leaves an unreferenced file.
    get_file_storage().save_file(document.storage_path, content, content_type)
    db.commit()
    log.info(
        "regulation_document.uploaded",
        extra={
            "company_id": str(ctx.company_id),
            "regulation_id": str(regulation.id),
            "regulation_document_id": str(document.id),
            "version_number": version_number,
            "content_type": content_type,
            "size_bytes": len(content),
        },
    )
    return document


def get_regulation_document(
    db: Session, ctx: CompanyContext, document_id: uuid.UUID
) -> RegulationDocument:
    document = regulation_queries.get_regulation_document(db, ctx.company_id, document_id)
    if not document:
        raise not_found_error("Regulation document")
    return document


def load_regulation_document_file(
    db: Session, ctx: CompanyContext, document_id: uuid.UUID
) -> tuple[RegulationDocument, bytes]:
    document = get_regulation_document(db, ctx, document_id)
    return document, get_file_storage().load_file(document.storage_path)


def list_regulations(
    db: Session, ctx: CompanyContext, official_id: str | None
) -> list[RegulationOut]:
    regulations = regulation_queries.list_regulations(
        db, ctx.company_id, official_id=_clean_text(official_id)
    )
    summaries = regulation_queries.summarize_versions_by_regulation(db, [r.id for r in regulations])
    responses = []
    for regulation in regulations:
        version_count, latest = summaries.get(regulation.id, (0, None))
        responses.append(
            RegulationOut(
                id=regulation.id,
                title=regulation.title,
                official_id=regulation.official_id,
                version_count=version_count,
                latest_version=RegulationDocumentOut.model_validate(latest) if latest else None,
                created_at=regulation.created_at,
            )
        )
    return responses


def get_regulation_detail(
    db: Session, ctx: CompanyContext, regulation_id: uuid.UUID
) -> RegulationDetailOut:
    regulation = regulation_queries.get_regulation(db, ctx.company_id, regulation_id)
    if not regulation:
        raise not_found_error("Regulation")
    versions = [
        RegulationDocumentOut.model_validate(v)
        for v in regulation_queries.list_regulation_versions(db, regulation.id)
    ]
    return RegulationDetailOut(
        id=regulation.id,
        title=regulation.title,
        official_id=regulation.official_id,
        version_count=len(versions),
        latest_version=versions[0] if versions else None,
        created_at=regulation.created_at,
        versions=versions,
    )
