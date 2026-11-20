"""Which patients a doctor may open (decision 040, user 16 Nov 2026).

A doctor sees a patient when they are, or were, truly that patient's doctor:
- a booked appointment with them today or later; or
- an appointment with them that was completed (a recording for it was uploaded), at any time.

Then they see the whole record: history, every past appointment, recording and remark. A first
appointment that was cancelled or missed before it was completed gives nothing. Assignments from
before v8 no longer count.

Decision 061 (user, 20 Nov 2026): a doctor whose appointment was moved to another doctor keeps
**view-only** access to that patient: they can read the record, recordings, reports, remarks and
reviews, but give no new remark or review and change nothing (plan, record links). The patient is
shown to them as "Moved to <new doctor>"."""

from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session as DbSession

from app.models import Appointment, Patient, RecordingRequest, Session, Take
from app.security import Principal

#: Hospital staff who see every patient of their hospital (a doctor sees only their own).
ALL_PATIENTS_ROLES = {"hospital_admin", "receptionist"}


def doctor_patients_clause(doctor_id: str):
    """SQL condition on Patient.id: patients this doctor may open."""
    since = datetime.now(UTC) - timedelta(days=1)  # today's appointments count as upcoming
    upcoming = select(Appointment.patient_id).where(
        Appointment.doctor_id == doctor_id, Appointment.status == "booked", Appointment.at >= since
    )
    completed = (
        select(Appointment.patient_id)
        .join(RecordingRequest, RecordingRequest.appointment_id == Appointment.id)
        .join(Session, Session.request_id == RecordingRequest.id)
        .join(Take, Take.session_id == Session.id)
        .where(Appointment.doctor_id == doctor_id, Take.status == "complete")
    )
    return or_(Patient.id.in_(upcoming), Patient.id.in_(completed))


def doctor_patient_ids(db: DbSession, doctor_id: str) -> set[str]:
    return set(db.scalars(select(Patient.id).where(doctor_patients_clause(doctor_id))))


def assigned_ids(db: DbSession, doctor_id: str) -> set[str]:
    """Kept for callers from before v8: the same as doctor_patient_ids."""
    return doctor_patient_ids(db, doctor_id)


def moved_away_clause(doctor_id: str):
    """SQL condition on Patient.id: patients with an appointment moved from this doctor to another."""
    return Patient.id.in_(
        select(Appointment.patient_id).where(
            Appointment.moved_from_doctor_id == doctor_id, Appointment.doctor_id != doctor_id
        )
    )


def doctor_view_only_ids(db: DbSession, doctor_id: str) -> set[str]:
    """Decision 061: patients this doctor may only view (reached only through a moved appointment)."""
    moved = set(db.scalars(select(Patient.id).where(moved_away_clause(doctor_id))))
    return moved - doctor_patient_ids(db, doctor_id)


def moved_to_names(db: DbSession, doctor_id: str, patient_ids: set[str]) -> dict[str, str]:
    """Decision 061: per patient, the doctor their latest appointment moved away from this doctor to
    went to (display name, else e-mail)."""
    from app.models import StaffUser

    if not patient_ids:
        return {}
    rows = db.execute(
        select(Appointment.patient_id, StaffUser.display_name, StaffUser.email)
        .join(StaffUser, StaffUser.id == Appointment.doctor_id)
        .where(
            Appointment.moved_from_doctor_id == doctor_id,
            Appointment.doctor_id != doctor_id,
            Appointment.patient_id.in_(patient_ids),
        )
        .order_by(Appointment.moved_at)
    )
    return {pid: name or email for pid, name, email in rows}


def check_patient_access(db: DbSession, p: Principal, patient: Patient, *, view: bool = False) -> None:
    """404 (not 403) for a patient the doctor has no appointment with: existence is not revealed.
    Decision 061: `view=True` for reading only; then view-only access (a moved appointment) counts,
    and otherwise it gives 403 "moved_view_only"."""
    if p.role != "doctor" or patient.id in doctor_patient_ids(db, p.actor_id):
        return
    if patient.id in doctor_view_only_ids(db, p.actor_id):
        if view:
            return
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "moved_view_only"})
    raise HTTPException(status.HTTP_404_NOT_FOUND, "patient not found")
