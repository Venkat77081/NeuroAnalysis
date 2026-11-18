"""v13: appointment changes. Hospital settings, the desk's moves, patients' change requests, notices
for the connector, and doctors' clinic hours.

Revision ID: 0021
Revises: 0020
"""

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)
JSON = sa.JSON().with_variant(JSONB(), "postgresql")


def upgrade() -> None:
    with op.batch_alter_table("sites") as t:
        t.add_column(sa.Column("settings", JSON, nullable=True))
    with op.batch_alter_table("appointments") as t:
        t.add_column(sa.Column("external_at", TS, nullable=True))
        t.add_column(sa.Column("moved_at", TS, nullable=True))
        t.add_column(sa.Column("moved_from", TS, nullable=True))
        t.add_column(sa.Column("moved_from_doctor_id", sa.String(32), nullable=True))
        t.add_column(sa.Column("moved_reason", sa.String(24), nullable=True))
    op.execute(sa.text("UPDATE appointments SET external_at = at WHERE source = 'fhir'"))
    op.create_table(
        "appointment_change_requests",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("site_id", sa.String(32), sa.ForeignKey("sites.id"), nullable=False, index=True),
        sa.Column("patient_id", sa.String(32), sa.ForeignKey("patients.id"), nullable=False, index=True),
        sa.Column(
            "appointment_id", sa.String(32), sa.ForeignKey("appointments.id"), nullable=False, index=True
        ),
        sa.Column("days", JSON, nullable=False),
        sa.Column("part_of_day", sa.String(10), nullable=False),
        sa.Column("reason", sa.String(20), nullable=True),
        sa.Column("status", sa.String(10), nullable=False, server_default="open"),
        sa.Column("answer", sa.String(20), nullable=True),
        sa.Column("answered_by", sa.String(32), nullable=True),
        sa.Column("answered_at", TS, nullable=True),
        sa.Column("created_at", TS, nullable=False),
    )
    op.create_table(
        "appointment_notices",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("site_id", sa.String(32), sa.ForeignKey("sites.id"), nullable=False, index=True),
        sa.Column("patient_id", sa.String(32), sa.ForeignKey("patients.id"), nullable=False),
        sa.Column("appointment_id", sa.String(32), sa.ForeignKey("appointments.id"), nullable=False),
        sa.Column("kind", sa.String(12), nullable=False),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("sent_at", TS, nullable=True),
    )
    op.create_table(
        "doctor_hours",
        sa.Column("doctor_id", sa.String(32), sa.ForeignKey("staff_users.id"), primary_key=True),
        sa.Column("site_id", sa.String(32), sa.ForeignKey("sites.id"), nullable=False, index=True),
        sa.Column("department", sa.String(80), nullable=True),
        sa.Column("week", JSON, nullable=False),
        sa.Column("slot_minutes", sa.Integer, nullable=False, server_default="15"),
        sa.Column("leave", JSON, nullable=False),
        sa.Column("updated_by", sa.String(32), nullable=True),
        sa.Column("updated_at", TS, nullable=False),
    )


def downgrade() -> None:
    op.drop_table("doctor_hours")
    op.drop_table("appointment_notices")
    op.drop_table("appointment_change_requests")
    with op.batch_alter_table("appointments") as t:
        for c in ("moved_reason", "moved_from_doctor_id", "moved_from", "moved_at", "external_at"):
            t.drop_column(c)
    with op.batch_alter_table("sites") as t:
        t.drop_column("settings")
