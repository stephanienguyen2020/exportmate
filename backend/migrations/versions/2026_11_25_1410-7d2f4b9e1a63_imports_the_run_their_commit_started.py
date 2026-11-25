"""imports: the run their commit started

Revision ID: 7d2f4b9e1a63
Revises: 5c1e8a2f9b70
Create Date: 2026-11-22 15:10:00

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "7d2f4b9e1a63"
down_revision: str | Sequence[str] | None = "5c1e8a2f9b70"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("imports", sa.Column("run_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        "imports_run_id_fkey", "imports", "analysis_runs", ["run_id"], ["id"], ondelete="SET NULL"
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint("imports_run_id_fkey", "imports", type_="foreignkey")
    op.drop_column("imports", "run_id")
