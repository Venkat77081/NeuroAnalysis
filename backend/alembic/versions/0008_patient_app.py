"""Patient app (PLATFORM_PLAN M13): recording plans and deletion requests.

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-15
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None

J = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "recording_plans",
        sa.Column("patient_id", sa.String(32), sa.ForeignKey("patients.id"), primary_key=True),
        sa.Column("tests", J, nullable=False),
        sa.Column("every_days", sa.Integer(), nullable=False),
        sa.Column("med_state", sa.String(3), nullable=False),
        sa.Column("updated_by", sa.String(32), nullable=False),
        sa.Column("updated_at", TS, nullable=False),
    )
    op.create_table(
        "deletion_requests",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("site_id", sa.String(32), sa.ForeignKey("sites.id"), nullable=False),
        sa.Column("patient_id", sa.String(32), sa.ForeignKey("patients.id"), nullable=False),
        sa.Column("requested_at", TS, nullable=False),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("done_at", TS),
        sa.Column("done_by", sa.String(32)),
    )
    op.create_index("ix_deletion_requests_site_id", "deletion_requests", ["site_id"])


def downgrade() -> None:
    op.drop_index("ix_deletion_requests_site_id", table_name="deletion_requests")
    op.drop_table("deletion_requests")
    op.drop_table("recording_plans")
