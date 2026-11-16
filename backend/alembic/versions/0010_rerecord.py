"""Re-record requests from the doctor dashboard (PLATFORM_PLAN M14).

Revision ID: 0010
Revises: 0009
Create Date: 2026-11-15
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

J = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    with op.batch_alter_table("recording_plans") as t:
        t.add_column(sa.Column("rerecord_requested_at", sa.DateTime(timezone=True)))
        t.add_column(sa.Column("rerecord_tests", J))


def downgrade() -> None:
    with op.batch_alter_table("recording_plans") as t:
        t.drop_column("rerecord_tests")
        t.drop_column("rerecord_requested_at")
