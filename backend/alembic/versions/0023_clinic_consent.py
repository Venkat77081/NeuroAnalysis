"""v16 (decision 047): consent for clinic recordings, given in the patient's app (QR) or on the
clinic phone; sessions keep where consent came from.

Revision ID: 0023
Revises: 0022
"""

import sqlalchemy as sa

from alembic import op

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None

TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "clinic_consents",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("site_id", sa.String(32), sa.ForeignKey("sites.id"), nullable=False, index=True),
        sa.Column("patient_id", sa.String(32), sa.ForeignKey("patients.id"), nullable=False),
        sa.Column("request_id", sa.String(32), nullable=False, index=True),
        sa.Column("source", sa.String(12), nullable=False),
        sa.Column("code_hash", sa.String(64), nullable=True, unique=True),
        sa.Column("reason", sa.String(24), nullable=True),
        sa.Column("consent_version", sa.String(50), nullable=False),
        sa.Column("agreed_at", TS, nullable=False),
        sa.Column("valid_until", TS, nullable=False),
        sa.Column("status", sa.String(10), nullable=False, server_default="active"),
        sa.Column("used_at", TS, nullable=True),
        sa.Column("used_by", sa.String(32), nullable=True),
        sa.Column("session_id", sa.String(32), nullable=True),
    )
    with op.batch_alter_table("sessions") as t:
        t.add_column(sa.Column("consent_source", sa.String(12), nullable=True))
        t.add_column(sa.Column("consent_reason", sa.String(24), nullable=True))
        t.add_column(sa.Column("consent_id", sa.String(32), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("sessions") as t:
        for c in ("consent_id", "consent_reason", "consent_source"):
            t.drop_column(c)
    op.drop_table("clinic_consents")
