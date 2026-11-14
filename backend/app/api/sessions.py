"""Sessions (one DNE record per patient visit; DEV_PLAN §13.2, decision 017)."""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.audit import audit
from app.db import get_db
from app.models import Patient, Session
from app.security import Principal, current_principal

router = APIRouter(prefix="/sessions", tags=["sessions"])


class PatientIn(BaseModel):
    #: SHA-256(site salt + reference), computed on the phone; the reference never leaves it.
    ref_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    year_of_birth: int | None = Field(default=None, ge=1900, le=2100)
    sex: str | None = Field(default=None, pattern=r"^[MFO]$")


class SessionIn(BaseModel):
    client_session_id: str = Field(min_length=1, max_length=64)
    patient: PatientIn
    med_state: str = Field(pattern=r"^(ON|OFF|NA)$")
    started_at: datetime
    consent_version: str = Field(max_length=50)
    consent_at: datetime
    app_version: str = Field(max_length=20)
    config_versions: dict[str, str]


class SessionOut(BaseModel):
    id: str
    client_session_id: str


@router.post("", response_model=SessionOut, status_code=201)
def create_session(
    body: SessionIn,
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> SessionOut:
    existing = db.scalar(
        select(Session).where(
            Session.device_id == p.device.id, Session.client_session_id == body.client_session_id
        )
    )
    if existing:
        return SessionOut(id=existing.id, client_session_id=existing.client_session_id)
    site = p.operator.site_id
    patient = db.scalar(
        select(Patient).where(Patient.site_id == site, Patient.external_ref_hash == body.patient.ref_hash)
    )
    if not patient:
        patient = Patient(
            site_id=site,
            external_ref_hash=body.patient.ref_hash,
            year_of_birth=body.patient.year_of_birth,
            sex=body.patient.sex,
        )
        db.add(patient)
        db.flush()
    s = Session(
        client_session_id=body.client_session_id,
        patient_id=patient.id,
        operator_id=p.operator.id,
        device_id=p.device.id,
        started_at=body.started_at,
        med_state=body.med_state,
        app_version=body.app_version,
        config_versions=body.config_versions,
        consent_version=body.consent_version,
        consent_at=body.consent_at,
    )
    db.add(s)
    db.flush()
    audit(db, "operator", p.operator.id, "session_created", "session", s.id)
    db.commit()
    return SessionOut(id=s.id, client_session_id=s.client_session_id)


class AbortIn(BaseModel):
    reason: str = Field(pattern=r"^[a-z_]+$")
    note: str | None = Field(default=None, max_length=500)


class SessionClose(BaseModel):
    ended_at: datetime
    aborted: AbortIn | None = None


@router.patch("/{session_id}", response_model=SessionOut)
@router.post("/{session_id}/close", response_model=SessionOut)  # for clients without PATCH (Android)
def close_session(
    session_id: str,
    body: SessionClose,
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> SessionOut:
    s = db.get(Session, session_id)
    if not s or s.device_id != p.device.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "session not found")
    s.ended_at = body.ended_at
    s.aborted = body.aborted.model_dump() if body.aborted else None
    audit(db, "operator", p.operator.id, "session_closed", "session", s.id, aborted=body.aborted is not None)
    db.commit()
    return SessionOut(id=s.id, client_session_id=s.client_session_id)
