import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, Index, Integer, String, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.models.base import Base, created_column, id_column


class Regulation(Base):
    """A rule, e.g. "EU general product safety regulation". Its documents are its versions.

    Shared (company_id null): an official text everyone reads, added by the seed or the crawler.
    Otherwise it belongs to one company (its own uploads, e.g. a news article).
    """

    __tablename__ = "regulations"
    id: Mapped[uuid.UUID] = id_column()
    company_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    # Official identifier, e.g. EUR-Lex CELEX "32023R1115" or "7 CFR 357".
    official_id: Mapped[str | None] = mapped_column(String(100))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))  # null: system
    created_at: Mapped[datetime] = created_column()
    __table_args__ = (
        UniqueConstraint("company_id", "official_id"),
        # Postgres treats nulls as distinct, so shared regulations need their own index.
        Index(
            "ix_regulations_shared_official_id",
            "official_id",
            unique=True,
            postgresql_where=text("company_id IS NULL"),
        ),
    )


class RegulationDocument(Base):
    """One uploaded file = one version of a regulation (an official text or an article).

    The bytes live in Cloud Storage; this row keeps the hash and path.
    """

    __tablename__ = "regulation_documents"
    id: Mapped[uuid.UUID] = id_column()
    # The company comes from the regulation.
    regulation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("regulations.id", ondelete="CASCADE"), index=True, nullable=False
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    storage_path: Mapped[str] = mapped_column(String(500), nullable=False)
    source_url: Mapped[str | None] = mapped_column(String(2000))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))  # null: system
    created_at: Mapped[datetime] = created_column()
    __table_args__ = (
        # Blocks the same file twice in one regulation. Two companies never share a regulation,
        # so each company can upload the same file.
        UniqueConstraint("regulation_id", "checksum"),
        UniqueConstraint("regulation_id", "version_number"),
    )
