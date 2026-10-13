"""regulation documents get their company from the regulation

Revision ID: 2f313a8300e0
Revises: 7055df84aa27
Create Date: 2026-10-13 03:05:54.152574

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "2f313a8300e0"
down_revision: str | Sequence[str] | None = "7055df84aa27"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_index("ix_regulation_documents_company_id", table_name="regulation_documents")
    op.drop_constraint(
        "regulation_documents_company_id_checksum_key", "regulation_documents", type_="unique"
    )
    op.create_unique_constraint(
        "regulation_documents_regulation_id_checksum_key",
        "regulation_documents",
        ["regulation_id", "checksum"],
    )
    op.drop_constraint(
        "regulation_documents_company_id_fkey", "regulation_documents", type_="foreignkey"
    )
    op.drop_column("regulation_documents", "company_id")


def downgrade() -> None:
    """Downgrade schema."""
    op.add_column("regulation_documents", sa.Column("company_id", sa.UUID(), nullable=True))
    op.execute(
        "UPDATE regulation_documents AS d SET company_id = r.company_id "
        "FROM regulations AS r WHERE r.id = d.regulation_id"
    )
    op.alter_column("regulation_documents", "company_id", nullable=False)
    op.create_foreign_key(
        "regulation_documents_company_id_fkey",
        "regulation_documents",
        "companies",
        ["company_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.drop_constraint(
        "regulation_documents_regulation_id_checksum_key", "regulation_documents", type_="unique"
    )
    op.create_unique_constraint(
        "regulation_documents_company_id_checksum_key",
        "regulation_documents",
        ["company_id", "checksum"],
    )
    op.create_index(
        "ix_regulation_documents_company_id", "regulation_documents", ["company_id"], unique=False
    )
