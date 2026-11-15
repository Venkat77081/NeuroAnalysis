"""Hospital connector registration (PLATFORM_PLAN M11).

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-15
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

J = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    with op.batch_alter_table("sites") as t:
        t.add_column(sa.Column("connector_public_key", sa.Text()))
        t.add_column(sa.Column("connector_check", J))
        t.add_column(sa.Column("connector_checked_at", sa.DateTime(timezone=True)))


def downgrade() -> None:
    with op.batch_alter_table("sites") as t:
        t.drop_column("connector_checked_at")
        t.drop_column("connector_check")
        t.drop_column("connector_public_key")
