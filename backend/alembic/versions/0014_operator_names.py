"""Operator names (user, 16 Nov 2026): activity logs show who did what by name.

Revision ID: 0014
Revises: 0013
"""

import sqlalchemy as sa

from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("operators") as t:
        t.add_column(sa.Column("name", sa.String(120)))


def downgrade() -> None:
    with op.batch_alter_table("operators") as t:
        t.drop_column("name")
