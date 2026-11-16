"""Operator lockout after repeated wrong passwords (M13: phones unlock with the server).

Revision ID: 0009
Revises: 0008
Create Date: 2026-11-15
"""

import sqlalchemy as sa

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("operators") as t:
        t.add_column(sa.Column("failed_logins", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    with op.batch_alter_table("operators") as t:
        t.drop_column("failed_logins")
