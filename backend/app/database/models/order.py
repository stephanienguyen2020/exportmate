import enum
import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.database.models.base import Base, created_column, id_column, pg_enum


class OrderStatus(str, enum.Enum):
    awaiting_analysis = "awaiting_analysis"
    clear = "clear"
    exposed = "exposed"
    needs_data = "needs_data"


class ImportStatus(str, enum.Enum):
    validated = "validated"  # no errors, ready to commit
    invalid = "invalid"  # has errors, cannot commit
    committed = "committed"


class Import(Base):
    __tablename__ = "imports"
    id: Mapped[uuid.UUID] = id_column()
    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), index=True, nullable=False
    )
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    status: Mapped[ImportStatus] = mapped_column(
        pg_enum(ImportStatus, "import_status"), nullable=False
    )
    row_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    errors: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = created_column()
    committed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ImportRow(Base):
    """One CSV row as uploaded, so reports can cite "import X, row N"."""

    __tablename__ = "import_rows"
    id: Mapped[uuid.UUID] = id_column()
    import_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("imports.id", ondelete="CASCADE"), index=True, nullable=False
    )
    row_number: Mapped[int] = mapped_column(Integer, nullable=False)  # spreadsheet row, header = 1
    raw: Mapped[dict] = mapped_column(JSONB, nullable=False)
    row_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    # Validated order fields (dates as ISO text); None when the row has errors.
    order_fields: Mapped[dict | None] = mapped_column(JSONB)
    __table_args__ = (UniqueConstraint("import_id", "row_number"),)


class Order(Base):
    __tablename__ = "orders"
    id: Mapped[uuid.UUID] = id_column()
    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), index=True, nullable=False
    )
    external_id: Mapped[str] = mapped_column(String(100), nullable=False)
    product: Mapped[str] = mapped_column(String(300), nullable=False)
    supplier: Mapped[str] = mapped_column(String(300), nullable=False)
    destination: Mapped[str] = mapped_column(String(200), nullable=False)
    value_minor: Mapped[int] = mapped_column(BigInteger, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    ship_date: Mapped[date] = mapped_column(Date, nullable=False)
    hs_code: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[OrderStatus] = mapped_column(
        pg_enum(OrderStatus, "order_status"),
        nullable=False,
        default=OrderStatus.awaiting_analysis,
    )
    source_row_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("import_rows.id"))
    created_at: Mapped[datetime] = created_column()
    __table_args__ = (
        UniqueConstraint("company_id", "external_id"),
        # Past orders with similar product names (HS code suggestions).
        Index(
            "ix_orders_product_trgm",
            "product",
            postgresql_using="gin",
            postgresql_ops={"product": "gin_trgm_ops"},
        ),
    )
