"""trade risk tables: order pairs, import figures, features, scores and past cases

Revision ID: b4e8d2a61c35
Revises: 9d3f5a7c2e61
Create Date: 2026-11-25 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "b4e8d2a61c35"
down_revision: str | Sequence[str] | None = "9d3f5a7c2e61"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "order_trade_pairs",
        sa.Column("order_id", sa.UUID(), nullable=False),
        sa.Column("market", sa.String(length=4), nullable=False),
        sa.Column("exporter", sa.String(length=2), nullable=False),
        sa.Column("hs6", sa.String(length=6), nullable=False),
        sa.ForeignKeyConstraint(["order_id"], ["orders.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("order_id"),
    )
    op.create_index(
        "ix_order_trade_pairs_pair",
        "order_trade_pairs",
        ["market", "exporter", "hs6"],
        unique=False,
    )
    op.create_table(
        "import_figures",
        sa.Column("market", sa.String(length=4), nullable=False),
        sa.Column("exporter", sa.String(length=2), nullable=False),
        sa.Column("hs6", sa.String(length=6), nullable=False),
        sa.Column("period", sa.String(length=7), nullable=False),
        sa.Column("source", sa.String(length=10), nullable=False),
        sa.Column("period_kind", sa.String(length=5), nullable=False),
        sa.Column("value_usd", sa.Float(), nullable=False),
        sa.Column("tonnes", sa.Float(), nullable=True),
        sa.Column(
            "fetched_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("market", "exporter", "hs6", "period", "source"),
    )
    op.create_table(
        "trade_flow_features",
        sa.Column("market", sa.String(length=4), nullable=False),
        sa.Column("exporter", sa.String(length=2), nullable=False),
        sa.Column("hs6", sa.String(length=6), nullable=False),
        sa.Column("model_hs6", sa.String(length=6), nullable=False),
        sa.Column("features", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("data_from", sa.String(length=7), nullable=False),
        sa.Column("data_to", sa.String(length=7), nullable=False),
        sa.Column("data_source", sa.String(length=10), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("market", "exporter", "hs6"),
    )
    op.create_table(
        "trade_risk_scores",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("market", sa.String(length=4), nullable=False),
        sa.Column("exporter", sa.String(length=2), nullable=False),
        sa.Column("hs6", sa.String(length=6), nullable=False),
        sa.Column("model_hs6", sa.String(length=6), nullable=True),
        sa.Column("level", sa.String(length=10), nullable=False),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("percentile", sa.Float(), nullable=True),
        sa.Column("reasons", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("model_version", sa.String(length=40), nullable=False),
        sa.Column("data_from", sa.String(length=7), nullable=True),
        sa.Column("data_to", sa.String(length=7), nullable=True),
        sa.Column("data_source", sa.String(length=10), nullable=True),
        sa.Column(
            "scored_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_trade_risk_scores_pair",
        "trade_risk_scores",
        ["market", "exporter", "hs6", "scored_at"],
        unique=False,
    )
    op.create_table(
        "trade_cases",
        sa.Column("case_id", sa.String(length=80), nullable=False),
        sa.Column("market", sa.String(length=4), nullable=False),
        sa.Column("exporter", sa.String(length=2), nullable=False),
        sa.Column("hs6", sa.String(length=6), nullable=False),
        sa.Column("kind", sa.String(length=3), nullable=False),
        sa.Column("opened_on", sa.Date(), nullable=False),
        sa.Column("final_measure_on", sa.Date(), nullable=True),
        sa.Column("revoked_on", sa.Date(), nullable=True),
        sa.Column("measure_status", sa.String(length=30), nullable=True),
        sa.Column("duty_pct", sa.Float(), nullable=True),
        sa.Column("product", sa.Text(), nullable=True),
        sa.Column("source", sa.String(length=20), nullable=False),
        sa.PrimaryKeyConstraint("case_id", "market", "exporter", "hs6"),
    )
    op.create_index("ix_trade_cases_hs6", "trade_cases", ["hs6"], unique=False)
    op.create_index("ix_trade_cases_market_hs6", "trade_cases", ["market", "hs6"], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_trade_cases_market_hs6", table_name="trade_cases")
    op.drop_index("ix_trade_cases_hs6", table_name="trade_cases")
    op.drop_table("trade_cases")
    op.drop_index("ix_trade_risk_scores_pair", table_name="trade_risk_scores")
    op.drop_table("trade_risk_scores")
    op.drop_table("trade_flow_features")
    op.drop_table("import_figures")
    op.drop_index("ix_order_trade_pairs_pair", table_name="order_trade_pairs")
    op.drop_table("order_trade_pairs")
