"""companies: demo_expires_at, for demo visitors' sandboxes

Revision ID: 5c1d2e3f4a5b
Revises: 46a214bfa4e0
Create Date: 2026-11-24 12:00:00

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5c1d2e3f4a5b"
down_revision: str | Sequence[str] | None = "46a214bfa4e0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "companies", sa.Column("demo_expires_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_index(
        op.f("ix_companies_demo_expires_at"), "companies", ["demo_expires_at"], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_companies_demo_expires_at"), table_name="companies")
    op.drop_column("companies", "demo_expires_at")
