"""biomarker_runs (DEV_PLAN §13.1, M8): server readiness per take; results later.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-14
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

J = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "biomarker_runs",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("take_id", sa.String(32), sa.ForeignKey("takes.id"), nullable=False),
        sa.Column("registry_version", sa.String(20), nullable=False),
        sa.Column("source", sa.String(12), nullable=False),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("readiness", J, nullable=False),
        sa.Column("results", J),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_biomarker_runs_take_id", "biomarker_runs", ["take_id"])


def downgrade() -> None:
    op.drop_index("ix_biomarker_runs_take_id", table_name="biomarker_runs")
    op.drop_table("biomarker_runs")
