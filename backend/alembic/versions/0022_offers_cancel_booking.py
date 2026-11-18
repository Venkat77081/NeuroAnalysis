"""v14 (decision 046): the desk's offers of held times, cancellations with a reason, booking from
the app (patient requests of kind "booking" with exact times), doctors bookable in the app, and the
earlier tests kept for a new doctor to confirm.

Revision ID: 0022
Revises: 0021
"""

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)
JSON = sa.JSON().with_variant(JSONB(), "postgresql")


def upgrade() -> None:
    with op.batch_alter_table("appointments") as t:
        t.add_column(sa.Column("cancelled_by", sa.String(10), nullable=True))
        t.add_column(sa.Column("cancel_reason", sa.String(24), nullable=True))
        t.add_column(sa.Column("cancelled_at", TS, nullable=True))
        t.add_column(sa.Column("cancel_seen_at", TS, nullable=True))
        t.add_column(sa.Column("suggested_tests", JSON, nullable=True))
    with op.batch_alter_table("appointment_change_requests") as t:
        t.alter_column("appointment_id", existing_type=sa.String(32), nullable=True)
        t.alter_column("days", existing_type=JSON, nullable=True)
        t.alter_column("part_of_day", existing_type=sa.String(10), nullable=True)
        t.add_column(sa.Column("kind", sa.String(8), nullable=False, server_default="change"))
        t.add_column(sa.Column("doctor_id", sa.String(32), nullable=True))
        t.add_column(sa.Column("any_doctor", sa.Boolean, nullable=False, server_default=sa.false()))
        t.add_column(sa.Column("choices", JSON, nullable=True))
        t.add_column(sa.Column("purpose", sa.String(20), nullable=True))
    with op.batch_alter_table("appointment_notices") as t:
        t.alter_column("appointment_id", existing_type=sa.String(32), nullable=True)
        t.add_column(sa.Column("offer_id", sa.String(32), nullable=True))
    with op.batch_alter_table("doctor_hours") as t:
        t.add_column(sa.Column("bookable", sa.Boolean, nullable=False, server_default=sa.true()))
    op.create_table(
        "appointment_offers",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("site_id", sa.String(32), sa.ForeignKey("sites.id"), nullable=False, index=True),
        sa.Column("patient_id", sa.String(32), sa.ForeignKey("patients.id"), nullable=False, index=True),
        sa.Column("appointment_id", sa.String(32), sa.ForeignKey("appointments.id"), nullable=True, index=True),
        sa.Column("request_id", sa.String(32), nullable=True),
        sa.Column("options", JSON, nullable=False),
        sa.Column("current_possible", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("reason", sa.String(24), nullable=False),
        sa.Column("reply_by", TS, nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="open"),
        sa.Column("chosen", sa.Integer, nullable=True),
        sa.Column("answered_at", TS, nullable=True),
        sa.Column("created_by", sa.String(32), nullable=False),
        sa.Column("created_at", TS, nullable=False),
    )


def downgrade() -> None:
    op.drop_table("appointment_offers")
    with op.batch_alter_table("doctor_hours") as t:
        t.drop_column("bookable")
    with op.batch_alter_table("appointment_notices") as t:
        t.drop_column("offer_id")
    op.execute(sa.text("DELETE FROM appointment_notices WHERE appointment_id IS NULL"))
    op.execute(sa.text("DELETE FROM appointment_change_requests WHERE kind = 'booking' OR days IS NULL"))
    with op.batch_alter_table("appointment_change_requests") as t:
        for c in ("purpose", "choices", "any_doctor", "doctor_id", "kind"):
            t.drop_column(c)
    with op.batch_alter_table("appointments") as t:
        for c in ("suggested_tests", "cancel_seen_at", "cancelled_at", "cancel_reason", "cancelled_by"):
            t.drop_column(c)
