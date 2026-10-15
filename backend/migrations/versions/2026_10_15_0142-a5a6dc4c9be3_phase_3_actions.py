"""phase 3 actions: supplier contacts, owner review of reports, supplier messages, report
feedback

Revision ID: a5a6dc4c9be3
Revises: 9a3e5c1d7f42
Create Date: 2026-10-15 01:42:43.337950

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "a5a6dc4c9be3"
down_revision: str | Sequence[str] | None = "9a3e5c1d7f42"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "report_feedback",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("company_id", sa.UUID(), nullable=False),
        sa.Column("report_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("useful", sa.Boolean(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["company_id"], ["companies.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["report_id"], ["analysis_reports.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("report_id", "user_id"),
    )
    op.create_index(
        op.f("ix_report_feedback_report_id"), "report_feedback", ["report_id"], unique=False
    )
    op.create_table(
        "supplier_messages",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("company_id", sa.UUID(), nullable=False),
        sa.Column("report_id", sa.UUID(), nullable=False),
        sa.Column("order_id", sa.UUID(), nullable=False),
        sa.Column("supplier_id", sa.UUID(), nullable=True),
        sa.Column(
            "status",
            sa.Enum("draft", "approved", "sent", "failed", name="supplier_message_status"),
            nullable=False,
        ),
        sa.Column("recipient", sa.String(length=254), nullable=True),
        sa.Column("subject", sa.String(length=200), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("created_by", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("approved_by", sa.UUID(), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("approved_hash", sa.String(length=64), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sandbox", sa.Boolean(), nullable=True),
        sa.Column("provider_message_id", sa.String(length=200), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(
            ["approved_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(["company_id"], ["companies.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
        ),
        sa.ForeignKeyConstraint(["order_id"], ["orders.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["report_id"], ["analysis_reports.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["supplier_id"], ["suppliers.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_supplier_messages_company_id"), "supplier_messages", ["company_id"], unique=False
    )
    op.create_index(
        op.f("ix_supplier_messages_order_id"), "supplier_messages", ["order_id"], unique=False
    )
    op.create_index(
        op.f("ix_supplier_messages_report_id"), "supplier_messages", ["report_id"], unique=False
    )
    op.add_column("analysis_reports", sa.Column("reviewed_by", sa.UUID(), nullable=True))
    op.add_column(
        "analysis_reports", sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("analysis_reports", sa.Column("review_note", sa.Text(), nullable=True))
    op.create_foreign_key(
        "analysis_reports_reviewed_by_fkey", "analysis_reports", "users", ["reviewed_by"], ["id"]
    )
    op.add_column("suppliers", sa.Column("contact_name", sa.String(length=200), nullable=True))
    op.add_column("suppliers", sa.Column("contact_email", sa.String(length=254), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("suppliers", "contact_email")
    op.drop_column("suppliers", "contact_name")
    # WARNING: constraint name is None; this directive will fail as
    # rendered.  Add a name, or use a naming convention; see
    # https://alembic.sqlalchemy.org/en/latest/naming.html
    op.drop_constraint("analysis_reports_reviewed_by_fkey", "analysis_reports", type_="foreignkey")
    op.drop_column("analysis_reports", "review_note")
    op.drop_column("analysis_reports", "reviewed_at")
    op.drop_column("analysis_reports", "reviewed_by")
    op.drop_index(op.f("ix_supplier_messages_report_id"), table_name="supplier_messages")
    op.drop_index(op.f("ix_supplier_messages_order_id"), table_name="supplier_messages")
    op.drop_index(op.f("ix_supplier_messages_company_id"), table_name="supplier_messages")
    op.drop_table("supplier_messages")
    op.drop_index(op.f("ix_report_feedback_report_id"), table_name="report_feedback")
    op.drop_table("report_feedback")
    postgresql.ENUM(name="supplier_message_status").drop(op.get_bind())
