"""v10: the hospital connector reports whether its e-mail and SMS work (decision 042). Only
"working / failing / off" and when; the settings themselves stay at the connector.

Revision ID: 0018
Revises: 0017
"""

import sqlalchemy as sa

from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("sites") as t:
        t.add_column(sa.Column("messaging_status", sa.JSON()))


def downgrade() -> None:
    with op.batch_alter_table("sites") as t:
        t.drop_column("messaging_status")
