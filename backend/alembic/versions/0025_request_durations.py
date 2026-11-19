"""v31 (decision 054): each recording request carries the take length for each of its tests
(the hospital's lengths, or the doctor's for this request).

Revision ID: 0025
Revises: 0024
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None

J = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    with op.batch_alter_table("recording_requests") as b:
        b.add_column(sa.Column("durations", J, nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("recording_requests") as b:
        b.drop_column("durations")
