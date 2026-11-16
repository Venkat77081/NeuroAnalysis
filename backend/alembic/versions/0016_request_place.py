"""Home or clinic recording requests (user, 16 Nov 2026): `place`, and why a clinic request was
not recorded.

Revision ID: 0016
Revises: 0015
"""

import sqlalchemy as sa

from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("recording_requests") as t:
        t.add_column(sa.Column("place", sa.String(6), nullable=False, server_default="home"))
        t.add_column(sa.Column("not_done_reason", sa.String(30)))
        t.add_column(sa.Column("not_done_by", sa.String(32)))


def downgrade() -> None:
    with op.batch_alter_table("recording_requests") as t:
        t.drop_column("not_done_by")
        t.drop_column("not_done_reason")
        t.drop_column("place")
