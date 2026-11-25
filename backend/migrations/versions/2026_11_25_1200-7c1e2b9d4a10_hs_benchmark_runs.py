"""hs benchmark runs: HS code suggestions scored on held-out customs rulings

Revision ID: 7c1e2b9d4a10
Revises: 46a214bfa4e0
Create Date: 2026-11-25 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "7c1e2b9d4a10"
down_revision: str | Sequence[str] | None = "46a214bfa4e0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "hs_benchmark_runs",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("model", sa.String(length=100), nullable=False),
        sa.Column("embedding_model", sa.String(length=100), nullable=False),
        sa.Column("dataset", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("case_count", sa.Integer(), nullable=False),
        sa.Column("metrics", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("results", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("hs_benchmark_runs")
