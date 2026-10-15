"""retire the needs_data order status: missing data makes an order exposed, with what to add
as its next step; the status stays for earlier status changes

Revision ID: 8b2e5f1c7a90
Revises: d985790d1f4d
Create Date: 2026-10-15 20:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "8b2e5f1c7a90"
down_revision: str | Sequence[str] | None = "d985790d1f4d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "order_statuses",
        sa.Column("retired", sa.Boolean(), server_default="false", nullable=False),
    )
    # seed_reference_data writes the same from reference.json; this covers a database that
    # is migrated without seeding.
    op.execute("UPDATE order_statuses SET retired = true, manual = false WHERE code = 'needs_data'")


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("UPDATE order_statuses SET manual = true WHERE code = 'needs_data'")
    op.drop_column("order_statuses", "retired")
