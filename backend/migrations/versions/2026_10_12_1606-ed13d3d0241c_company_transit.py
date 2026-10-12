"""company transit

Revision ID: ed13d3d0241c
Revises: bc881e59d9c1
Create Date: 2026-10-12 16:06:25.266838

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "ed13d3d0241c"
down_revision: str | Sequence[str] | None = "bc881e59d9c1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    # Existing companies start with a direct route; owners add stops in About company.
    op.add_column(
        "companies",
        sa.Column(
            "transit",
            postgresql.ARRAY(sa.String(length=100)),
            server_default="{}",
            nullable=False,
        ),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("companies", "transit")
