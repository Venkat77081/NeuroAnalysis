"""Doctor ↔ patient assignments and the receptionist role (M14).

Revision ID: 0011
Revises: 0010
Create Date: 2026-11-15
"""

import sqlalchemy as sa

from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "patient_assignments",
        sa.Column("patient_id", sa.String(32), sa.ForeignKey("patients.id"), primary_key=True),
        sa.Column("doctor_id", sa.String(32), sa.ForeignKey("staff_users.id"), nullable=False),
        sa.Column("assigned_by", sa.String(32), nullable=False),
        sa.Column("assigned_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_patient_assignments_doctor_id", "patient_assignments", ["doctor_id"])


def downgrade() -> None:
    op.drop_index("ix_patient_assignments_doctor_id", table_name="patient_assignments")
    op.drop_table("patient_assignments")
