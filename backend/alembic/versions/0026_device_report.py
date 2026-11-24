"""Decision 062: the phone check's details per phone (brand, video size, memory, storage).

Revision ID: 0026
Revises: 0025
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None

J = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    with op.batch_alter_table("devices") as b:
        b.add_column(sa.Column("device_report", J, nullable=True))
        b.add_column(sa.Column("device_report_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("devices") as b:
        b.drop_column("device_report_at")
        b.drop_column("device_report")
