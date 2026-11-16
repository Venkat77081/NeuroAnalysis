"""Per-hospital permissions (decision 033): overrides of the defaults in config/platform.json.

Revision ID: 0015
Revises: 0014
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("sites") as t:
        t.add_column(sa.Column("permissions", sa.JSON().with_variant(postgresql.JSONB(), "postgresql")))


def downgrade() -> None:
    with op.batch_alter_table("sites") as t:
        t.drop_column("permissions")
