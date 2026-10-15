"""order statuses and status changes: each status's label from the database, and a history of
manual (with a note) and analysis changes

Revision ID: 327bb5aff270
Revises: b2357fe65acb
Create Date: 2026-10-15 17:31:19.996328

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "327bb5aff270"
down_revision: str | Sequence[str] | None = "b2357fe65acb"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The order_status type exists since the first migration.
ORDER_STATUS = postgresql.ENUM(
    "awaiting_analysis", "clear", "exposed", "needs_data", name="order_status", create_type=False
)


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "order_statuses",
        sa.Column("code", ORDER_STATUS, nullable=False),
        sa.Column("label", sa.String(length=100), nullable=False),
        sa.Column("description", sa.String(length=500), nullable=False),
        sa.Column("tone", sa.String(length=20), nullable=False),
        sa.Column("manual", sa.Boolean(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("code"),
    )
    op.create_table(
        "order_status_changes",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("company_id", sa.UUID(), nullable=False),
        sa.Column("order_id", sa.UUID(), nullable=False),
        sa.Column("from_status", ORDER_STATUS, nullable=False),
        sa.Column("to_status", ORDER_STATUS, nullable=False),
        sa.Column(
            "source", sa.Enum("manual", "analysis", name="status_change_source"), nullable=False
        ),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("run_id", sa.UUID(), nullable=True),
        sa.Column("changed_by", sa.UUID(), nullable=False),
        sa.Column(
            "changed_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "source <> 'analysis' OR run_id IS NOT NULL", name="analysis_status_change_has_run"
        ),
        sa.CheckConstraint(
            "source <> 'manual' OR note IS NOT NULL", name="manual_status_change_has_note"
        ),
        sa.ForeignKeyConstraint(["changed_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["company_id"], ["companies.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["order_id"], ["orders.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["run_id"], ["analysis_runs.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_order_status_changes_order_id"), "order_status_changes", ["order_id"], unique=False
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_order_status_changes_order_id"), table_name="order_status_changes")
    op.drop_table("order_status_changes")
    op.drop_table("order_statuses")
    sa.Enum(name="status_change_source").drop(op.get_bind(), checkfirst=True)
