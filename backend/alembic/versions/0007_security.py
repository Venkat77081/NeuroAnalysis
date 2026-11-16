"""Security hardening before M13 (decision 027): shared nonce store; pre-M10 operators must choose
a new password (their 4-digit PIN was kept as the password).

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-15
"""

import sqlalchemy as sa

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "used_nonces",
        sa.Column("nonce", sa.String(64), primary_key=True),
        sa.Column("signer", sa.String(64), nullable=False),
        sa.Column("seen_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_used_nonces_seen_at", "used_nonces", ["seen_at"])
    ops = sa.table("operators", sa.column("must_change_password", sa.Boolean))
    op.get_bind().execute(ops.update().values(must_change_password=True))


def downgrade() -> None:
    op.drop_index("ix_used_nonces_seen_at", table_name="used_nonces")
    op.drop_table("used_nonces")
