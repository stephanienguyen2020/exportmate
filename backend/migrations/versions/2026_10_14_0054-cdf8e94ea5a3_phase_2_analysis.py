"""phase 2 analysis: duty rates, checked playbook rules, cost settings, runs, reports,
supplier document uploads

Revision ID: cdf8e94ea5a3
Revises: 5b7da3a00089
Create Date: 2026-10-14 00:54:09.400530

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "cdf8e94ea5a3"
down_revision: str | Sequence[str] | None = "5b7da3a00089"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

upload_status = postgresql.ENUM("draft", "confirmed", name="supplier_document_upload_status")
run_status = postgresql.ENUM("running", "done", "failed", name="run_status")
report_state = postgresql.ENUM(
    "pass", "needs_data", "rejected", "needs_human_review", name="report_state"
)
# Exists since the orders migration.
order_status = postgresql.ENUM(name="order_status", create_type=False)


def upgrade() -> None:
    bind = op.get_bind()
    for enum in (upload_status, run_status, report_state):
        enum.create(bind)

    # A duty the regulation sets as a share of the order value.
    op.add_column(
        "market_requirements",
        sa.Column("duty_rate_percent", sa.Numeric(precision=6, scale=2), nullable=True),
    )

    # Checked playbook rules.
    op.add_column("playbook_rules", sa.Column("conditions", postgresql.JSONB(), nullable=True))
    op.add_column("playbook_rules", sa.Column("action", sa.String(length=20), nullable=True))
    op.add_column("playbook_rules", sa.Column("action_note", sa.Text(), nullable=True))

    # Cost settings.
    op.create_table(
        "cost_defaults",
        sa.Column("key", sa.String(length=40), nullable=False),
        sa.Column("label", sa.String(length=150), nullable=False),
        sa.Column("unit", sa.String(length=4), nullable=False),
        sa.Column("value", sa.BigInteger(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )
    op.create_table(
        "company_cost_settings",
        sa.Column("company_id", sa.UUID(), nullable=False),
        sa.Column("key", sa.String(length=40), nullable=False),
        sa.Column("unit", sa.String(length=4), nullable=False),
        sa.Column("value", sa.BigInteger(), nullable=False),
        sa.Column("updated_by", sa.UUID(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["company_id"], ["companies.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["key"], ["cost_defaults.key"]),
        sa.ForeignKeyConstraint(["updated_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("company_id", "key"),
    )

    # Runs and reports.
    op.create_table(
        "analysis_runs",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("company_id", sa.UUID(), nullable=False),
        sa.Column("status", postgresql.ENUM(name="run_status", create_type=False), nullable=False),
        sa.Column("order_count", sa.Integer(), nullable=False),
        sa.Column("steps", postgresql.JSONB(), nullable=False),
        sa.Column("playbook_revision", sa.Integer(), nullable=False),
        sa.Column("cost_settings", postgresql.JSONB(), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_by", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["company_id"], ["companies.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_analysis_runs_company_id", "analysis_runs", ["company_id"])
    op.create_table(
        "analysis_reports",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("run_id", sa.UUID(), nullable=False),
        sa.Column("company_id", sa.UUID(), nullable=False),
        sa.Column("order_id", sa.UUID(), nullable=False),
        sa.Column("state", postgresql.ENUM(name="report_state", create_type=False), nullable=False),
        sa.Column("order_status", order_status, nullable=False),
        sa.Column("blocked", sa.Boolean(), nullable=False),
        sa.Column("content", postgresql.JSONB(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["company_id"], ["companies.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["order_id"], ["orders.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["run_id"], ["analysis_runs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_analysis_reports_order_latest", "analysis_reports", ["order_id", "created_at"]
    )
    op.create_index("ix_analysis_reports_run_id", "analysis_reports", ["run_id"])

    # Supplier document uploads (AI reads the file; a person confirms).
    op.create_table(
        "supplier_document_uploads",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("company_id", sa.UUID(), nullable=False),
        sa.Column("supplier_id", sa.UUID(), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=100), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("checksum", sa.String(length=64), nullable=False),
        sa.Column("storage_path", sa.String(length=500), nullable=False),
        sa.Column("extracted", postgresql.JSONB(), nullable=False),
        sa.Column(
            "status",
            postgresql.ENUM(name="supplier_document_upload_status", create_type=False),
            nullable=False,
        ),
        sa.Column("created_by", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("confirmed_by", sa.UUID(), nullable=True),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["company_id"], ["companies.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["confirmed_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["supplier_id"], ["suppliers.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_supplier_document_uploads_company_id", "supplier_document_uploads", ["company_id"]
    )
    op.create_index(
        "ix_supplier_document_uploads_supplier_id", "supplier_document_uploads", ["supplier_id"]
    )
    op.add_column(
        "supplier_documents", sa.Column("document_number", sa.String(length=100), nullable=True)
    )
    op.add_column("supplier_documents", sa.Column("issuer", sa.String(length=200), nullable=True))
    op.add_column("supplier_documents", sa.Column("expires_on", sa.Date(), nullable=True))
    op.add_column("supplier_documents", sa.Column("upload_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        "supplier_documents_upload_id_fkey",
        "supplier_documents",
        "supplier_document_uploads",
        ["upload_id"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "supplier_documents_upload_id_fkey", "supplier_documents", type_="foreignkey"
    )
    for column in ("upload_id", "expires_on", "issuer", "document_number"):
        op.drop_column("supplier_documents", column)
    op.drop_table("supplier_document_uploads")
    op.drop_table("analysis_reports")
    op.drop_table("analysis_runs")
    op.drop_table("company_cost_settings")
    op.drop_table("cost_defaults")
    for column in ("action_note", "action", "conditions"):
        op.drop_column("playbook_rules", column)

    op.drop_column("market_requirements", "duty_rate_percent")

    bind = op.get_bind()
    for enum in (report_state, run_status, upload_status):
        enum.drop(bind)
