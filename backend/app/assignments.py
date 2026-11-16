"""Which patients a doctor may open (decision 040, user 16 Nov 2026).

A doctor sees a patient when they are, or were, truly that patient's doctor:
- a booked appointment with them today or later; or
- an appointment with them that was completed (a recording for it was uploaded), at any time.

Then they see the whole record: history, every past appointment, recording and remark. A first
appointment that was cancelled, moved to another doctor or missed before it was completed gives
nothing. Assignments from before v8 no longer count."""

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


def check_patient_access(db: DbSession, p: Principal, patient: Patient) -> None:
    """404 (not 403) for a patient the doctor has no appointment with: existence is not revealed."""
    if p.role == "doctor" and patient.id not in doctor_patient_ids(db, p.actor_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient not found")
