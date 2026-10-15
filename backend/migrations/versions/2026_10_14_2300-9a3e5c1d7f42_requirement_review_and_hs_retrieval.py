"""requirement review and HS retrieval: company requirements drafted by AI and reviewed by the
owner, HS headings with embeddings (pgvector), HS code suggestions, trigram search on products

Revision ID: 9a3e5c1d7f42
Revises: cdf8e94ea5a3
Create Date: 2026-10-14 23:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

revision: str = "9a3e5c1d7f42"
down_revision: str | Sequence[str] | None = "cdf8e94ea5a3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

requirement_status = postgresql.ENUM(
    "draft", "reviewed", "rejected", "replaced", name="requirement_status"
)
hs_suggestion_status = postgresql.ENUM(
    "pending", "accepted", "rejected", name="hs_suggestion_status"
)


def upgrade() -> None:
    # Cloud SQL and the pgvector/pgvector image ship both; the app's database user may create them.
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    bind = op.get_bind()
    requirement_status.create(bind)
    hs_suggestion_status.create(bind)

    # Market requirements: a company's own (drafted by AI), review, and whether the quote was found.
    op.add_column("market_requirements", sa.Column("company_id", sa.UUID(), nullable=True))
    op.add_column(
        "market_requirements",
        sa.Column("quote_verified", sa.Boolean(), nullable=False, server_default="true"),
    )
    op.add_column(
        "market_requirements",
        sa.Column(
            "status",
            postgresql.ENUM(name="requirement_status", create_type=False),
            nullable=False,
            server_default="reviewed",  # every existing row came from the reviewed seed
        ),
    )
    op.alter_column("market_requirements", "status", server_default=None)
    op.add_column("market_requirements", sa.Column("reviewed_by", sa.UUID(), nullable=True))
    op.add_column(
        "market_requirements", sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.drop_constraint(
        "market_requirements_market_code_requirement_key_key", "market_requirements", type_="unique"
    )
    op.create_unique_constraint(
        "market_requirements_document_market_key_key",
        "market_requirements",
        ["regulation_document_id", "market_code", "requirement_key"],
    )
    op.create_index("ix_market_requirements_company_id", "market_requirements", ["company_id"])
    op.create_foreign_key(
        "market_requirements_company_id_fkey",
        "market_requirements",
        "companies",
        ["company_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "market_requirements_reviewed_by_fkey",
        "market_requirements",
        "users",
        ["reviewed_by"],
        ["id"],
    )

    # Official HS headings, searched by meaning (embedding) and by words (trigram).
    op.create_table(
        "hs_headings",
        sa.Column("code", sa.String(length=7), nullable=False),
        sa.Column("digits", sa.String(length=6), nullable=False),
        sa.Column("level", sa.Integer(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("text_hash", sa.String(length=64), nullable=False),
        sa.Column("embedding", Vector(768), nullable=True),
        sa.PrimaryKeyConstraint("code"),
        sa.UniqueConstraint("digits", name="hs_headings_digits_key"),
    )
    op.execute(
        "CREATE INDEX ix_hs_headings_description_trgm ON hs_headings "
        "USING gin (description gin_trgm_ops)"
    )

    op.create_table(
        "hs_code_suggestions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("company_id", sa.UUID(), nullable=False),
        sa.Column("order_id", sa.UUID(), nullable=False),
        sa.Column("hs_code", sa.String(length=20), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("based_on", postgresql.JSONB(), nullable=False),
        sa.Column(
            "status",
            postgresql.ENUM(name="hs_suggestion_status", create_type=False),
            nullable=False,
        ),
        sa.Column("created_by", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("decided_by", sa.UUID(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["company_id"], ["companies.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["decided_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["order_id"], ["orders.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_hs_code_suggestions_order_id", "hs_code_suggestions", ["order_id"])

    # The company's past orders with a code, found by similar product names.
    op.execute("CREATE INDEX ix_orders_product_trgm ON orders USING gin (product gin_trgm_ops)")


def downgrade() -> None:
    op.execute("DROP INDEX ix_orders_product_trgm")
    op.drop_table("hs_code_suggestions")
    op.drop_table("hs_headings")
    # Back to one row per market and key.
    op.execute(
        "DELETE FROM market_requirements WHERE company_id IS NOT NULL OR status <> 'reviewed'"
    )
    op.drop_constraint(
        "market_requirements_reviewed_by_fkey", "market_requirements", type_="foreignkey"
    )
    op.drop_constraint(
        "market_requirements_company_id_fkey", "market_requirements", type_="foreignkey"
    )
    op.drop_index("ix_market_requirements_company_id", table_name="market_requirements")
    op.drop_constraint(
        "market_requirements_document_market_key_key", "market_requirements", type_="unique"
    )
    op.create_unique_constraint(
        "market_requirements_market_code_requirement_key_key",
        "market_requirements",
        ["market_code", "requirement_key"],
    )
    for column in ("reviewed_at", "reviewed_by", "status", "quote_verified", "company_id"):
        op.drop_column("market_requirements", column)
    bind = op.get_bind()
    hs_suggestion_status.drop(bind)
    requirement_status.drop(bind)
    # The extensions stay: other databases objects may use them.
