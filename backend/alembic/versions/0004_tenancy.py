"""Tenancy, roles and identity core (PLATFORM_PLAN M10, decision 023).

Hospitals become tenants; dashboard staff, one-time phone registration codes and patient app
accounts (by NCID only) are added. No column holds a patient's name, MRN, e-mail or phone.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-15
"""

from uuid import uuid4

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

J = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    with op.batch_alter_table("sites") as t:
        t.add_column(sa.Column("kind", sa.String(10), nullable=False, server_default="hospital"))
        t.add_column(sa.Column("data_mode", sa.String(10), nullable=False, server_default="managed"))
        t.add_column(sa.Column("status", sa.String(12), nullable=False, server_default="active"))
        t.add_column(sa.Column("modules", J, nullable=True))
        t.add_column(sa.Column("city", sa.String(100)))
        t.add_column(sa.Column("connector_url", sa.String(300)))
        t.add_column(sa.Column("sms_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))
        t.add_column(sa.Column("onboarded_by", sa.String(32)))
        t.add_column(sa.Column("onboarded_at", TS))
    sites = sa.table("sites", sa.column("modules", J))
    op.get_bind().execute(sites.update().values(modules={"clinic": True, "home": False}))
    with op.batch_alter_table("sites") as t:
        t.alter_column("modules", existing_type=J, nullable=False)
    with op.batch_alter_table("operators") as t:
        t.add_column(
            sa.Column("must_change_password", sa.Boolean(), nullable=False, server_default=sa.false())
        )
    with op.batch_alter_table("devices") as t:
        t.add_column(sa.Column("kind", sa.String(10), nullable=False, server_default="clinic"))
        t.add_column(sa.Column("label", sa.String(60)))

    with op.batch_alter_table("patients") as t:
        t.add_column(sa.Column("ncid", sa.String(40), nullable=True))
        t.alter_column("external_ref_hash", existing_type=sa.String(64), nullable=True)
    patients = sa.table("patients", sa.column("id", sa.String), sa.column("ncid", sa.String))
    conn = op.get_bind()
    for (pid,) in conn.execute(sa.select(patients.c.id)).fetchall():
        conn.execute(patients.update().where(patients.c.id == pid).values(ncid="nc_" + uuid4().hex))
    with op.batch_alter_table("patients") as t:
        t.alter_column("ncid", existing_type=sa.String(40), nullable=False)
        t.create_unique_constraint("uq_patients_ncid", ["ncid"])

    with op.batch_alter_table("sessions") as t:
        t.alter_column("operator_id", existing_type=sa.String(32), nullable=True)
        t.add_column(sa.Column("recorded_by", sa.String(10), nullable=False, server_default="operator"))

    with op.batch_alter_table("audit_events") as t:
        t.add_column(sa.Column("site_id", sa.String(32)))
        t.create_index("ix_audit_events_site_id", ["site_id"])

    op.create_table(
        "staff_users",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("site_id", sa.String(32), sa.ForeignKey("sites.id")),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("email", sa.String(254), nullable=False, unique=True),
        sa.Column("display_name", sa.String(120)),
        sa.Column("password_hash", sa.String(200)),
        sa.Column("totp_secret", sa.String(64)),
        sa.Column("totp_enabled", sa.Boolean(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("failed_logins", sa.Integer(), nullable=False),
        sa.Column("invite_token_hash", sa.String(64), unique=True),
        sa.Column("invite_expires_at", TS),
        sa.Column("created_by", sa.String(32)),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("last_login_at", TS),
    )
    op.create_table(
        "staff_refresh_tokens",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("user_id", sa.String(32), sa.ForeignKey("staff_users.id"), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("revoked", sa.Boolean(), nullable=False),
    )
    op.create_table(
        "device_enrollments",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("site_id", sa.String(32), sa.ForeignKey("sites.id"), nullable=False),
        sa.Column("code_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("label", sa.String(60)),
        sa.Column("created_by", sa.String(32), nullable=False),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("used_at", TS),
        sa.Column("device_id", sa.String(32)),
    )
    op.create_table(
        "patient_accounts",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("site_id", sa.String(32), sa.ForeignKey("sites.id"), nullable=False),
        sa.Column("patient_id", sa.String(32), sa.ForeignKey("patients.id"), nullable=False, unique=True),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("invite_token_hash", sa.String(64), unique=True),
        sa.Column("invite_expires_at", TS),
        sa.Column("invite_channel", sa.String(10)),
        sa.Column("pin_hash", sa.String(200)),
        sa.Column("failed_pins", sa.Integer(), nullable=False),
        sa.Column("device_id", sa.String(32), sa.ForeignKey("devices.id")),
        sa.Column("consent_version", sa.String(50)),
        sa.Column("consent_at", TS),
        sa.Column("created_by", sa.String(32)),
        sa.Column("created_at", TS, nullable=False),
    )
    op.create_table(
        "patient_refresh_tokens",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("account_id", sa.String(32), sa.ForeignKey("patient_accounts.id"), nullable=False),
        sa.Column("device_id", sa.String(32), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("revoked", sa.Boolean(), nullable=False),
    )


def downgrade() -> None:
    for name in ("patient_refresh_tokens", "patient_accounts", "device_enrollments"):
        op.drop_table(name)
    op.drop_table("staff_refresh_tokens")
    op.drop_table("staff_users")
    with op.batch_alter_table("audit_events") as t:
        t.drop_index("ix_audit_events_site_id")
        t.drop_column("site_id")
    with op.batch_alter_table("sessions") as t:
        t.drop_column("recorded_by")
    with op.batch_alter_table("patients") as t:
        t.drop_constraint("uq_patients_ncid", type_="unique")
        t.drop_column("ncid")
    with op.batch_alter_table("devices") as t:
        t.drop_column("label")
        t.drop_column("kind")
    with op.batch_alter_table("operators") as t:
        t.drop_column("must_change_password")
    with op.batch_alter_table("sites") as t:
        for c in ("onboarded_at", "onboarded_by", "sms_enabled", "connector_url", "city", "modules",
                  "status", "data_mode", "kind"):
            t.drop_column(c)
