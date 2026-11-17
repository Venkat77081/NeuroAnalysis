"""v11 (decision 043): patient app accounts (e-mail fingerprint, PIN, encrypted backup), one-time
e-mail codes and signed-in phones.

Revision ID: 0019
Revises: 0018
"""

import sqlalchemy as sa

from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "app_accounts",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("email_fp", sa.String(64), nullable=False, unique=True),
        sa.Column("pin_hash", sa.String(200), nullable=False),
        sa.Column("failed_pins", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("paused_until", TS),
        sa.Column("kdf_salt", sa.String(64), nullable=False),
        sa.Column("recovery_check_hash", sa.String(64)),
        sa.Column("backup", sa.Text()),
        sa.Column("wrap_pin", sa.Text()),
        sa.Column("wrap_recovery", sa.Text()),
        sa.Column("backup_at", TS),
        sa.Column("created_at", TS, nullable=False),
    )
    op.create_table(
        "app_account_codes",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("email_fp", sa.String(64), nullable=False, index=True),
        sa.Column("code_hash", sa.String(64), nullable=False),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("used", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", TS, nullable=False),
    )
    op.create_table(
        "app_account_tokens",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("account_id", sa.String(32), sa.ForeignKey("app_accounts.id"), nullable=False, index=True),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("install_id", sa.String(64), nullable=False),
        sa.Column("device_label", sa.String(120), nullable=False),
        sa.Column("last_used_at", TS, nullable=False),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("revoked", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("revoked_reason", sa.String(20)),
    )


def downgrade() -> None:
    op.drop_table("app_account_tokens")
    op.drop_table("app_account_codes")
    op.drop_table("app_accounts")
