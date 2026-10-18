"""chain versions: drafts and published versions of each industry's material chain

Revision ID: 9ae784c446d4
Revises: a4105604da09
Create Date: 2026-10-18 06:12:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "9ae784c446d4"
down_revision: str | Sequence[str] | None = "a4105604da09"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "chain_versions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("industry", sa.String(length=40), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column(
            "status",
            sa.Enum("draft", "published", "superseded", "rejected", name="chain_version_status"),
            nullable=False,
        ),
        sa.Column("content", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("flagged", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("origin", sa.String(length=20), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("reviewed_by", sa.UUID(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("review_note", sa.Text(), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["reviewed_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("industry", "number"),
    )
    op.create_index(op.f("ix_chain_versions_industry"), "chain_versions", ["industry"])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_chain_versions_industry"), table_name="chain_versions")
    op.drop_table("chain_versions")
    op.execute("DROP TYPE IF EXISTS chain_version_status")
