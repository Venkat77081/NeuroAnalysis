"""Receptionist (M14): assign and reassign the hospital's patients to its doctors."""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.assignments import follow_assignment
from app.audit import audit
from app.db import get_db
from app.models import Patient, PatientAssignment, StaffUser
from app.security import Principal, require_role

router = APIRouter(prefix="/hospital", tags=["assignments"])
desk = require_role("receptionist")  # decision 031: not the hospital admin


class DoctorOut(BaseModel):
    id: str
    display_name: str | None
    email: str
    active: bool
    patients: int


@router.get("/doctors", response_model=list[DoctorOut])
def doctors(p: Principal = Depends(desk), db: DbSession = Depends(get_db)) -> list[DoctorOut]:
    docs = db.scalars(
        select(StaffUser)
        .where(StaffUser.site_id == p.site_id, StaffUser.role == "doctor")
        .order_by(StaffUser.display_name)
    )
    counts: dict[str, int] = {}
    for doc_id in db.scalars(select(PatientAssignment.doctor_id)):
        counts[doc_id] = counts.get(doc_id, 0) + 1
    return [
        DoctorOut(
            id=d.id, display_name=d.display_name, email=d.email, active=d.active, patients=counts.get(d.id, 0)
        )
        for d in docs
    ]


class AssignIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: null = unassign
    doctor_id: str | None


class AssignOut(BaseModel):
    ncid: str
    doctor_id: str | None
    assigned_at: datetime | None


@router.put("/patients/{ncid}/doctor", response_model=AssignOut)
def assign(
    ncid: str,
    body: AssignIn,
    p: Principal = Depends(desk),
    db: DbSession = Depends(get_db),
) -> AssignOut:
    """Assign (or reassign, or unassign) a patient. The previous doctor loses access at once."""
    patient = db.scalar(select(Patient).where(Patient.ncid == ncid, Patient.site_id == p.site_id))
    if not patient:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient not found")
    current = db.get(PatientAssignment, patient.id)
    if body.doctor_id is None:
        if current:
            audit(
                db,
                p.actor_type,
                p.actor_id,
                "patient_unassigned",
                "patient",
                patient.id,
                site_id=p.site_id,
                previous=current.doctor_id,
            )
            db.delete(current)
            follow_assignment(db, patient.id, None)  # back to "needs a doctor"
            db.commit()
        return AssignOut(ncid=ncid, doctor_id=None, assigned_at=None)
    doctor = db.get(StaffUser, body.doctor_id)
    if not doctor or doctor.site_id != p.site_id or doctor.role != "doctor" or not doctor.active:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "not_a_doctor_here"})
    previous = current.doctor_id if current else None
    if current:
        current.doctor_id, current.assigned_by, current.assigned_at = doctor.id, p.actor_id, datetime.now(UTC)
    else:
        current = PatientAssignment(
            patient_id=patient.id, doctor_id=doctor.id, assigned_by=p.actor_id, assigned_at=datetime.now(UTC)
        )
        db.add(current)
    action = "patient_reassigned" if previous and previous != doctor.id else "patient_assigned"
    audit(
        db,
        p.actor_type,
        p.actor_id,
        action,
        "patient",
        patient.id,
        site_id=p.site_id,
        doctor=doctor.id,
        previous=previous,
        appointments_moved=follow_assignment(db, patient.id, doctor.id),
    )
    db.commit()
    return AssignOut(ncid=ncid, doctor_id=doctor.id, assigned_at=current.assigned_at)
