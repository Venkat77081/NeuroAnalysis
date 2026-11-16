"""Hospital-owned data only (decision 031): no NeuroCapture-run connector or key.

Every hospital and clinic runs its own connector and holds its own take key, so "data_mode" is
always "byo". (The setting was a label only; nothing else depended on it.)

Revision ID: 0013
Revises: 0012
"""

import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    sites = sa.table("sites", sa.column("data_mode", sa.String))
    op.get_bind().execute(sites.update().values(data_mode="byo"))
    with op.batch_alter_table("sites") as t:
        t.alter_column("data_mode", server_default="byo")


def downgrade() -> None:
    pass  # which hospitals were "managed" is not kept
