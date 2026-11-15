"""v3: appointments, recording requests, periodic plans, withdrawal history and retention.

Revision ID: 0012
Revises: 0011
Create Date: 2026-11-15
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None

J = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "appointments",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("site_id", sa.String(32), sa.ForeignKey("sites.id"), nullable=False),
        sa.Column("patient_id", sa.String(32), sa.ForeignKey("patients.id"), nullable=False),
        sa.Column("at", TS, nullable=False),
        sa.Column("doctor_id", sa.String(32), sa.ForeignKey("staff_users.id")),
        sa.Column("source", sa.String(6), nullable=False),
        sa.Column("external_ref_hash", sa.String(64)),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("created_by", sa.String(32), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.UniqueConstraint("site_id", "external_ref_hash"),
    )
    op.create_index("ix_appointments_site_id", "appointments", ["site_id"])
    op.create_index("ix_appointments_patient_id", "appointments", ["patient_id"])
    op.create_table(
        "recording_requests",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("site_id", sa.String(32), sa.ForeignKey("sites.id"), nullable=False),
        sa.Column("patient_id", sa.String(32), sa.ForeignKey("patients.id"), nullable=False),
        sa.Column("appointment_id", sa.String(32), sa.ForeignKey("appointments.id")),
        sa.Column("kind", sa.String(10), nullable=False),
        sa.Column("tests", J, nullable=False),
        sa.Column("med_state", sa.String(3), nullable=False),
        sa.Column("due_at", TS, nullable=False),
        sa.Column("remind", sa.Boolean(), nullable=False),
        sa.Column("reminder_sent_at", TS),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("created_by", sa.String(32), nullable=False),
        sa.Column("created_at", TS, nullable=False),
    )
    op.create_index("ix_recording_requests_site_id", "recording_requests", ["site_id"])
    op.create_index("ix_recording_requests_patient_id", "recording_requests", ["patient_id"])
    with op.batch_alter_table("sessions") as t:
        t.add_column(sa.Column("request_id", sa.String(32)))
        t.create_index("ix_sessions_request_id", ["request_id"])
    with op.batch_alter_table("patient_accounts") as t:
        t.add_column(sa.Column("withdrawn_at", TS))
    with op.batch_alter_table("recording_plans") as t:
        t.add_column(sa.Column("periodic", sa.Boolean(), nullable=False, server_default=sa.false()))
        t.add_column(sa.Column("periodic_since", TS))
    # Plans a doctor set before v3 had a cadence: keep them periodic.
    plans = sa.table("recording_plans", sa.column("periodic", sa.Boolean), sa.column("updated_by", sa.String))
    op.get_bind().execute(plans.update().where(plans.c.updated_by != "default").values(periodic=True))


def downgrade() -> None:
    with op.batch_alter_table("recording_plans") as t:
        t.drop_column("periodic_since")
        t.drop_column("periodic")
    with op.batch_alter_table("patient_accounts") as t:
        t.drop_column("withdrawn_at")
    with op.batch_alter_table("sessions") as t:
        t.drop_index("ix_sessions_request_id")
        t.drop_column("request_id")
    op.drop_index("ix_recording_requests_patient_id", table_name="recording_requests")
    op.drop_index("ix_recording_requests_site_id", table_name="recording_requests")
    op.drop_table("recording_requests")
    op.drop_index("ix_appointments_patient_id", table_name="appointments")
    op.drop_index("ix_appointments_site_id", table_name="appointments")
    op.drop_table("appointments")
