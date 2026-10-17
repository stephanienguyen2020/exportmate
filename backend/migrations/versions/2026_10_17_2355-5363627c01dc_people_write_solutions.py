"""people write solutions too: `solutions.model` is null for one a person wrote

Revision ID: 5363627c01dc
Revises: 43bbae082505
Create Date: 2026-10-17 23:55:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "5363627c01dc"
down_revision: str | Sequence[str] | None = "43bbae082505"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.alter_column("solutions", "model", existing_type=sa.String(length=100), nullable=True)


def downgrade() -> None:
    """Downgrade schema."""
    # Keep the solutions people wrote; an empty model names no AI.
    op.execute("UPDATE solutions SET model = '' WHERE model IS NULL")
    op.alter_column("solutions", "model", existing_type=sa.String(length=100), nullable=False)
