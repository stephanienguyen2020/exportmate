"""graph link weights: every company's verdicts per chain link, counted nightly

Revision ID: a4105604da09
Revises: f5303c6ec7e6
Create Date: 2026-10-18 05:31:26.756771

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a4105604da09"
down_revision: str | Sequence[str] | None = "f5303c6ec7e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "graph_link_weights",
        sa.Column("from_key", sa.String(length=80), nullable=False),
        sa.Column("to_key", sa.String(length=80), nullable=False),
        sa.Column("confirmed", sa.Integer(), nullable=False),
        sa.Column("rejected", sa.Integer(), nullable=False),
        sa.Column("weight", sa.Float(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("from_key", "to_key"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("graph_link_weights")
