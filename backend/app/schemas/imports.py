import uuid
from datetime import date, datetime

from app.database.models import ImportStatus
from app.schemas.common import CamelCaseModel


class ImportErrorOut(CamelCaseModel):
    row: int | None  # None for file-level errors
    field: str | None
    message: str


class PreviewRowOut(CamelCaseModel):
    row_number: int
    id: str
    product: str
    supplier: str
    destination: str
    value_minor: int
    currency: str
    ship_date: date
    hs_code: str


class ImportOut(CamelCaseModel):
    id: uuid.UUID
    filename: str
    status: ImportStatus
    row_count: int
    errors: list[ImportErrorOut]
    preview: list[PreviewRowOut]
    duplicate_of_import_id: uuid.UUID | None
    created_at: datetime
    committed_at: datetime | None


class CommitOut(CamelCaseModel):
    import_id: uuid.UUID
    orders_created: int
