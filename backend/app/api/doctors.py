"""The hospital's doctors, for choosing the doctor of an appointment (decision 038)."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from app.assignments import doctor_patients_clause
from app.db import get_db
from app.models import Patient, StaffUser
from app.permissions import require
from app.security import Principal

router = APIRouter(prefix="/hospital", tags=["appointments"])
# Decision 033: per-hospital permissions (config/platform.json `permissions`).
booking = require("appointments.view", "appointments.add", "appointments.assign")


class DoctorOut(BaseModel):
    id: str
    display_name: str | None
    email: str
    active: bool
    patients: int


@router.get("/doctors", response_model=list[DoctorOut])
def doctors(p: Principal = Depends(booking), db: DbSession = Depends(get_db)) -> list[DoctorOut]:
    docs = list(
        db.scalars(
            select(StaffUser)
            .where(StaffUser.site_id == p.site_id, StaffUser.role == "doctor")
            .order_by(StaffUser.display_name)
        )
    )
    # Decision 040: patients the doctor can see (upcoming or completed appointment).
    counts = {
        d.id: db.scalar(select(func.count()).select_from(Patient).where(doctor_patients_clause(d.id))) or 0
        for d in docs
    }
    return [
        DoctorOut(
            id=d.id, display_name=d.display_name, email=d.email, active=d.active, patients=counts.get(d.id, 0)
        )
        for d in docs
    ]
