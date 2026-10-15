"""company invites: an owner invites an email address to join the company with a role

Revision ID: 6c1f0e9a4d27
Revises: 327bb5aff270
Create Date: 2026-10-15 19:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "6c1f0e9a4d27"
down_revision: str | Sequence[str] | None = "327bb5aff270"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The member_role type exists since the first migration.
MEMBER_ROLE = postgresql.ENUM("owner", "editor", "viewer", name="member_role", create_type=False)


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "company_invites",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("company_id", sa.UUID(), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("role", MEMBER_ROLE, nullable=False),
        sa.Column("invited_by_user_id", sa.UUID(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["company_id"], ["companies.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["invited_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("company_id", "email"),
    )
    op.create_index(op.f("ix_company_invites_email"), "company_invites", ["email"], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_company_invites_email"), table_name="company_invites")
    op.drop_table("company_invites")
