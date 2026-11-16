"""Which patients a doctor may open (decision 038, user 16 Nov 2026: each appointment keeps its own
doctor). A doctor sees a patient they have an appointment with (upcoming or past, not cancelled),
a patient they sent a recording request to, or one assigned to them before v8. For such a patient
they see the whole record: history and every recording, whichever doctor's appointment it was."""

from fastapi import HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session as DbSession

from app.models import Appointment, Patient, PatientAssignment, RecordingRequest
from app.security import Principal

#: Hospital staff who see every patient of their hospital (a doctor sees only their own).
ALL_PATIENTS_ROLES = {"hospital_admin", "receptionist"}


def doctor_patients_clause(doctor_id: str):
    """SQL condition on Patient.id: patients this doctor may open."""
    by_appointment = select(Appointment.patient_id).where(
        Appointment.doctor_id == doctor_id, Appointment.status != "cancelled"
    )
    by_request = select(RecordingRequest.patient_id).where(RecordingRequest.created_by == doctor_id)
    legacy = select(PatientAssignment.patient_id).where(PatientAssignment.doctor_id == doctor_id)
    return or_(Patient.id.in_(by_appointment), Patient.id.in_(by_request), Patient.id.in_(legacy))


def doctor_patient_ids(db: DbSession, doctor_id: str) -> set[str]:
    return set(db.scalars(select(Patient.id).where(doctor_patients_clause(doctor_id))))


def assigned_ids(db: DbSession, doctor_id: str) -> set[str]:
    """Kept for callers from before v8: the same as doctor_patient_ids."""
    return doctor_patient_ids(db, doctor_id)


def check_patient_access(db: DbSession, p: Principal, patient: Patient) -> None:
    """404 (not 403) for a patient the doctor has no appointment with: existence is not revealed."""
    if p.role == "doctor" and patient.id not in doctor_patient_ids(db, p.actor_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient not found")
