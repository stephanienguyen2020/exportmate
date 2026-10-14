"""requirement effective dates and route sensitivity

Ship-date comparisons read effective_on and changes_on. Route comparisons read
route_sensitive. Checklist rows are reloaded by seed_reference_data.

Revision ID: b7c1a2e90d11
Revises: 64c7ef097f88
Create Date: 2026-10-14 05:45:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7c1a2e90d11"
down_revision: str | Sequence[str] | None = "64c7ef097f88"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("market_requirements", sa.Column("effective_on", sa.Date(), nullable=True))
    op.add_column("market_requirements", sa.Column("changes_on", sa.Date(), nullable=True))
    op.add_column(
        "market_requirements",
        sa.Column("change_note", sa.Text(), nullable=False, server_default=""),
    )
    op.add_column(
        "market_requirements",
        sa.Column("route_sensitive", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("market_requirements", "route_sensitive")
    op.drop_column("market_requirements", "change_note")
    op.drop_column("market_requirements", "changes_on")
    op.drop_column("market_requirements", "effective_on")
