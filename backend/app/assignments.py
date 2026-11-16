"""Doctor ↔ patient assignment checks (M14). Doctors see only their assigned patients."""

from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.models import Appointment, Patient, PatientAssignment
from app.security import Principal

#: Hospital staff who see every patient of their hospital (a doctor sees only assigned ones).
ALL_PATIENTS_ROLES = {"hospital_admin", "receptionist"}


def assigned_ids(db: DbSession, doctor_id: str) -> set[str]:
    return set(
        db.scalars(select(PatientAssignment.patient_id).where(PatientAssignment.doctor_id == doctor_id))
    )


def check_patient_access(db: DbSession, p: Principal, patient: Patient) -> None:
    """404 (not 403) for a doctor's unassigned patient: the patient's existence is not revealed."""
    if p.role == "doctor":
        a = db.get(PatientAssignment, patient.id)
        if not a or a.doctor_id != p.actor_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "patient not found")


def follow_assignment(db: DbSession, patient_id: str, doctor_id: str | None) -> int:
    """v3: a patient's upcoming appointments belong to the patient's assigned doctor, so the doctor
    who can see the patient is the one who chooses the tests. Past appointments keep their doctor.
    Returns how many appointments moved."""
    moved = 0
    since = datetime.now(UTC) - timedelta(days=1)  # today's appointments too
    for a in db.scalars(
        select(Appointment).where(
            Appointment.patient_id == patient_id,
            Appointment.status == "booked",
            Appointment.at >= since,
        )
    ):
        if a.doctor_id != doctor_id:
            a.doctor_id = doctor_id
            moved += 1
    return moved
