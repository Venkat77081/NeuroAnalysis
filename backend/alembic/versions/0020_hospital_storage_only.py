"""Decision 044: NeuroCapture stores no videos. Hospitals that were on NeuroCapture storage become
"not connected" (no production hospital used it); they connect their own S3 bucket or Azure
container before recording.

Revision ID: 0020
Revises: 0019
"""

import sqlalchemy as sa

from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(sa.text("UPDATE sites SET storage_kind = 'none' WHERE storage_kind = 'managed'"))
    with op.batch_alter_table("sites") as t:
        t.alter_column("storage_kind", server_default="none", existing_type=sa.String(10))


def downgrade() -> None:
    op.execute(sa.text("UPDATE sites SET storage_kind = 'managed' WHERE storage_kind IN ('none', 'dev')"))
