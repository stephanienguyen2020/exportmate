"""ports: transit hubs for the route what-if

Revision ID: 5c1e8a2f9b70
Revises: 46a214bfa4e0
Create Date: 2026-11-22 15:00:00

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "5c1e8a2f9b70"
down_revision: str | Sequence[str] | None = "46a214bfa4e0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema. The hubs themselves are flagged by seed_reference_data (reference.json)."""
    op.add_column(
        "ports",
        sa.Column("transit_hub", sa.Boolean(), server_default=sa.false(), nullable=False),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("ports", "transit_hub")
