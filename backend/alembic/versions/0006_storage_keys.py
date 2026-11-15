"""Per-hospital storage and keys (PLATFORM_PLAN M12).

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-15
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

J = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "site_keys",
        sa.Column("id", sa.String(50), primary_key=True),
        sa.Column("site_id", sa.String(32), sa.ForeignKey("sites.id"), nullable=False),
        sa.Column("public_key_pem", sa.Text(), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("retired_at", TS),
    )
    op.create_index("ix_site_keys_site_id", "site_keys", ["site_id"])
    with op.batch_alter_table("sites") as t:
        t.add_column(sa.Column("storage_kind", sa.String(10), nullable=False, server_default="managed"))
        t.add_column(sa.Column("storage_config", J))
        t.add_column(sa.Column("storage_external_id", sa.String(64)))
        t.add_column(sa.Column("storage_check", J))
        t.add_column(sa.Column("storage_checked_at", TS))
    with op.batch_alter_table("sessions") as t:
        t.add_column(sa.Column("key_id", sa.String(50)))
    with op.batch_alter_table("take_files") as t:
        t.add_column(sa.Column("location", J))
        t.add_column(sa.Column("checksum_verified", sa.Boolean()))
    # Files already uploaded were checked by the platform at completion.
    tf = sa.table("take_files", sa.column("uploaded_at", TS), sa.column("checksum_verified", sa.Boolean))
    op.get_bind().execute(tf.update().where(tf.c.uploaded_at.isnot(None)).values(checksum_verified=True))


def downgrade() -> None:
    with op.batch_alter_table("take_files") as t:
        t.drop_column("checksum_verified")
        t.drop_column("location")
    with op.batch_alter_table("sessions") as t:
        t.drop_column("key_id")
    with op.batch_alter_table("sites") as t:
        for c in ("storage_checked_at", "storage_check", "storage_external_id", "storage_config", "storage_kind"):
            t.drop_column(c)
    op.drop_index("ix_site_keys_site_id", table_name="site_keys")
    op.drop_table("site_keys")
