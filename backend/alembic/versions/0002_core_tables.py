"""Core tables (DEV_PLAN §13.1, M7): sites, operators, devices, refresh tokens, patients,
sessions, takes, take files, audit events.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-14
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

J = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "sites",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("region", sa.String(50), nullable=False),
        sa.Column("enrollment_code_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("patient_ref_salt", sa.String(64), nullable=False),
    )
    op.create_table(
        "operators",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("site_id", sa.String(32), sa.ForeignKey("sites.id"), nullable=False),
        sa.Column("code", sa.String(20), nullable=False),
        sa.Column("display_name_hash", sa.String(64)),
        sa.Column("pin_hash", sa.String(200), nullable=False),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("active", sa.Boolean, nullable=False),
        sa.UniqueConstraint("site_id", "code"),
    )
    op.create_table(
        "devices",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("site_id", sa.String(32), sa.ForeignKey("sites.id"), nullable=False),
        sa.Column("model", sa.String(100), nullable=False),
        sa.Column("os_version", sa.String(50), nullable=False),
        sa.Column("tier", sa.String(1)),
        sa.Column("qualification_report", J),
        sa.Column("secret_hash", sa.String(64), nullable=False),
        sa.Column("registered_at", TS, nullable=False),
        sa.Column("revoked_at", TS),
    )
    op.create_table(
        "refresh_tokens",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("operator_id", sa.String(32), sa.ForeignKey("operators.id"), nullable=False),
        sa.Column("device_id", sa.String(32), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("expires_at", TS, nullable=False),
        sa.Column("revoked", sa.Boolean, nullable=False),
    )
    op.create_table(
        "patients",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("site_id", sa.String(32), sa.ForeignKey("sites.id"), nullable=False),
        sa.Column("external_ref_hash", sa.String(64), nullable=False),
        sa.Column("year_of_birth", sa.Integer),
        sa.Column("sex", sa.String(1)),
        sa.UniqueConstraint("site_id", "external_ref_hash"),
    )
    op.create_table(
        "sessions",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("client_session_id", sa.String(64), nullable=False),
        sa.Column("patient_id", sa.String(32), sa.ForeignKey("patients.id"), nullable=False),
        sa.Column("operator_id", sa.String(32), sa.ForeignKey("operators.id"), nullable=False),
        sa.Column("device_id", sa.String(32), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column("started_at", TS, nullable=False),
        sa.Column("ended_at", TS),
        sa.Column("aborted", J),
        sa.Column("med_state", sa.String(3), nullable=False),
        sa.Column("app_version", sa.String(20), nullable=False),
        sa.Column("config_versions", J, nullable=False),
        sa.Column("consent_version", sa.String(50), nullable=False),
        sa.Column("consent_at", TS, nullable=False),
        sa.UniqueConstraint("device_id", "client_session_id"),
    )
    op.create_table(
        "takes",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("client_take_id", sa.String(64), nullable=False),
        sa.Column("session_id", sa.String(32), sa.ForeignKey("sessions.id"), nullable=False),
        sa.Column("test_code", sa.String(3), nullable=False),
        sa.Column("side", sa.String(1)),
        sa.Column("take_no", sa.Integer, nullable=False),
        sa.Column("capture_verdict", sa.String(8), nullable=False),
        sa.Column("override_reason", sa.String(50)),
        sa.Column("flagged_for_review", sa.Boolean, nullable=False),
        sa.Column("quality", J, nullable=False),
        sa.Column("meta", J, nullable=False),
        sa.Column("wrapped_data_key", sa.String(1024), nullable=False),
        sa.Column("key_id", sa.String(50), nullable=False),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("checksums", J, nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("uploaded_at", TS),
        sa.UniqueConstraint("session_id", "client_take_id"),
    )
    op.create_table(
        "take_files",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("take_id", sa.String(32), sa.ForeignKey("takes.id"), nullable=False),
        sa.Column("kind", sa.String(10), nullable=False),
        sa.Column("object_key", sa.String(300), nullable=False),
        sa.Column("upload_id", sa.String(300)),
        sa.Column("size_bytes", sa.Integer, nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("uploaded_at", TS),
        sa.UniqueConstraint("take_id", "kind"),
    )
    op.create_table(
        "audit_events",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("actor_id", sa.String(32)),
        sa.Column("actor_type", sa.String(20), nullable=False),
        sa.Column("action", sa.String(50), nullable=False),
        sa.Column("target_type", sa.String(20)),
        sa.Column("target_id", sa.String(32)),
        sa.Column("at", TS, nullable=False),
        sa.Column("details", J),
    )


def downgrade() -> None:
    for t in [
        "audit_events",
        "take_files",
        "takes",
        "sessions",
        "patients",
        "refresh_tokens",
        "devices",
        "operators",
        "sites",
    ]:
        op.drop_table(t)
