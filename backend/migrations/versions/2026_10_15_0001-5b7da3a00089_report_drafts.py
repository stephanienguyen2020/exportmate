"""report drafts

Order and company reports are generated into a draft its author edits, previews and sends.
`original` keeps the generated report so the PDF can mark every edited line.

Revision ID: 5b7da3a00089
Revises: b7c1a2e90d11
Create Date: 2026-10-15 00:01:45.473719

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "5b7da3a00089"
down_revision: str | Sequence[str] | None = "b7c1a2e90d11"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "report_drafts",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("company_id", sa.UUID(), nullable=False),
        sa.Column("created_by", sa.UUID(), nullable=False),
        sa.Column("kind", sa.Enum("order", "company", name="report_kind"), nullable=False),
        sa.Column("scope", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("original", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("content", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("sent_to", postgresql.ARRAY(sa.String(length=254)), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["company_id"], ["companies.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_report_drafts_company_id"), "report_drafts", ["company_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_report_drafts_company_id"), table_name="report_drafts")
    op.drop_table("report_drafts")
    sa.Enum(name="report_kind").drop(op.get_bind(), checkfirst=True)
