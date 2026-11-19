"""v29 (decision 052): hourly check-ins from each hospital's connector (counts only), for the
connector's last-24-hours strip and "offline since" on the dashboards.

Revision ID: 0024
Revises: 0023
"""

import sqlalchemy as sa

from alembic import op

revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "connector_pings",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("site_id", sa.String(32), sa.ForeignKey("sites.id"), nullable=False, index=True),
        sa.Column("hour", TS, nullable=False),
        sa.Column("count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("last_at", TS, nullable=False),
        sa.UniqueConstraint("site_id", "hour"),
    )


def downgrade() -> None:
    op.drop_table("connector_pings")
