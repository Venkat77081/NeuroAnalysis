"""Doctor ↔ patient assignment checks (M14). Doctors see only their assigned patients."""

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.models import Patient, PatientAssignment
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
