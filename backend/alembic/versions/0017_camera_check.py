"""Camera check before a phone is added (user, 16 Nov 2026): the measured frame rate of each
phone, and patients whose phone could not pass ("phone not suitable").

Revision ID: 0017
Revises: 0016
"""

import sqlalchemy as sa

from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    with op.batch_alter_table("devices") as t:
        t.add_column(sa.Column("check_fps", sa.Float()))
        t.add_column(sa.Column("checked_at", TS))
    with op.batch_alter_table("patient_accounts") as t:
        t.add_column(sa.Column("camera_failed_fps", sa.Float()))
        t.add_column(sa.Column("camera_failed_at", TS))


def downgrade() -> None:
    with op.batch_alter_table("patient_accounts") as t:
        t.drop_column("camera_failed_at")
        t.drop_column("camera_failed_fps")
    with op.batch_alter_table("devices") as t:
        t.drop_column("checked_at")
        t.drop_column("check_fps")
