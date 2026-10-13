"""shared regulations and sourced market requirements

Regulations without a company are shared official texts (added by the seed, later the crawler).
Each market requirement now cites the regulation document that sets it and a quote from it.

Revision ID: 64c7ef097f88
Revises: 2f313a8300e0
Create Date: 2026-10-13 13:31:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "64c7ef097f88"
down_revision: str | Sequence[str] | None = "2f313a8300e0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.alter_column("regulations", "company_id", existing_type=sa.UUID(), nullable=True)
    op.alter_column("regulations", "created_by", existing_type=sa.UUID(), nullable=True)
    op.alter_column("regulation_documents", "created_by", existing_type=sa.UUID(), nullable=True)
    op.create_index(
        "ix_regulations_shared_official_id",
        "regulations",
        ["official_id"],
        unique=True,
        postgresql_where=sa.text("company_id IS NULL"),
    )

    # Market requirements are reference data with no source yet: seed_reference_data (run by
    # deploy.sh after migrations) loads them again, each with its source.
    op.execute("DELETE FROM market_requirements")
    op.add_column(
        "market_requirements", sa.Column("regulation_document_id", sa.UUID(), nullable=False)
    )
    op.add_column("market_requirements", sa.Column("source_quote", sa.Text(), nullable=False))
    op.create_index(
        "ix_market_requirements_regulation_document_id",
        "market_requirements",
        ["regulation_document_id"],
        unique=False,
    )
    op.create_foreign_key(
        "market_requirements_regulation_document_id_fkey",
        "market_requirements",
        "regulation_documents",
        ["regulation_document_id"],
        ["id"],
    )


def downgrade() -> None:
    """Downgrade schema. Removes the shared regulations; reseed after upgrading again."""
    op.drop_constraint(
        "market_requirements_regulation_document_id_fkey", "market_requirements", type_="foreignkey"
    )
    op.drop_index("ix_market_requirements_regulation_document_id", table_name="market_requirements")
    op.drop_column("market_requirements", "source_quote")
    op.drop_column("market_requirements", "regulation_document_id")

    op.execute("DELETE FROM regulations WHERE company_id IS NULL")  # documents cascade
    op.drop_index("ix_regulations_shared_official_id", table_name="regulations")
    op.alter_column("regulation_documents", "created_by", existing_type=sa.UUID(), nullable=False)
    op.alter_column("regulations", "created_by", existing_type=sa.UUID(), nullable=False)
    op.alter_column("regulations", "company_id", existing_type=sa.UUID(), nullable=False)
