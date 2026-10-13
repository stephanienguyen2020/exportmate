import uuid
from datetime import datetime

from app.schemas.common import CamelCaseModel


class RegulationDocumentOut(CamelCaseModel):
    id: uuid.UUID
    title: str
    filename: str
    content_type: str
    size_bytes: int
    checksum: str
    source_url: str | None
    regulation_id: uuid.UUID
    version_number: int
    created_at: datetime


class RegulationOut(CamelCaseModel):
    id: uuid.UUID
    title: str
    official_id: str | None
    version_count: int
    latest_version: RegulationDocumentOut | None
    created_at: datetime


class RegulationDetailOut(RegulationOut):
    versions: list[RegulationDocumentOut]  # newest first
