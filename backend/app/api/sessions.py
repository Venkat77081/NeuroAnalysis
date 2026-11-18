"""Sessions (one DNE record per patient visit; DEV_PLAN §13.2, decision 017)."""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.audit import audit
from app.db import get_db
from app.hospital_keys import session_key
from app.models import Patient, Session, Site, SiteKey
from app.security import Principal, patient_of, require_device

router = APIRouter(prefix="/sessions", tags=["sessions"])


class PatientIn(BaseModel):
    """Who the session is for: an NCID (M10) or, from pre-M10 phones, a salted reference hash."""

    ncid: str | None = Field(default=None, pattern=r"^nc_[0-9a-f]{32}$")
    #: SHA-256(site salt + reference), computed on the phone; the reference never leaves it.
    ref_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    year_of_birth: int | None = Field(default=None, ge=1900, le=2100)
    sex: str | None = Field(default=None, pattern=r"^[MFO]$")


class SessionIn(BaseModel):
    client_session_id: str = Field(min_length=1, max_length=64)
    #: Required for operators; a patient's own phone records for that patient only.
    patient: PatientIn | None = None
    med_state: str = Field(pattern=r"^(ON|OFF|NA)$")
    started_at: datetime
    consent_version: str = Field(max_length=50)
    consent_at: datetime
    app_version: str = Field(max_length=20)
    config_versions: dict[str, str]
    #: v3: the recording request this session answers (patient app).
    request_id: str | None = Field(default=None, max_length=32)
    #: v16 (decision 047): the confirmed clinic consent (QR scanned, or on the clinic phone).
    consent_id: str | None = Field(default=None, max_length=32)


class EncryptionKey(BaseModel):
    """M12: wrap every take data key of this session with this RSA-OAEP public key."""

    key_id: str
    public_key_pem: str
    #: hospital = only the hospital's connector can decrypt; platform = pre-M12 / managed fallback.
    owner: str


class SessionOut(BaseModel):
    id: str
    client_session_id: str
    encryption_key: EncryptionKey | None = None


def _key_out(db: DbSession, s: Session) -> EncryptionKey | None:
    if s.key_id is None:
        return None
    k = db.get(SiteKey, s.key_id)
    if k:
        return EncryptionKey(key_id=k.id, public_key_pem=k.public_key_pem, owner="hospital")
    from app.keys import server_public_key

    key_id, pem = server_public_key()
    return EncryptionKey(key_id=key_id, public_key_pem=pem, owner="platform") if key_id == s.key_id else None


def _patient_for(db: DbSession, p: Principal, given: PatientIn | None) -> Patient:
    if p.kind == "patient":
        own = patient_of(db, p)
        if given and given.ncid and own and given.ncid != own.ncid:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "a patient records for themselves only")
        assert own is not None
        return own
    if not given or not (given.ncid or given.ref_hash):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "patient ncid or ref_hash required")
    if given.ncid:
        patient = db.scalar(select(Patient).where(Patient.ncid == given.ncid, Patient.site_id == p.site_id))
        if not patient:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown NCID for this hospital")
        return patient
    from app.config import get_settings

    if not get_settings().allow_legacy_ref_hash:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "ncid_required"})
    patient = db.scalar(
        select(Patient).where(Patient.site_id == p.site_id, Patient.external_ref_hash == given.ref_hash)
    )
    if not patient:
        patient = Patient(
            site_id=p.site_id,
            external_ref_hash=given.ref_hash,
            year_of_birth=given.year_of_birth,
            sex=given.sex,
        )
        db.add(patient)
        db.flush()
    return patient


def require_storage(site: Site) -> None:
    from app.storage.sites import StorageNotConnectedError, location_for

    try:
        location_for(site)
    except StorageNotConnectedError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "storage_not_connected"}) from exc


class CanRecordOut(BaseModel):
    """Decision 044: phones check this before offering Start / a record link."""

    can_record: bool
    #: storage_not_connected | storage_failing | null
    reason: str | None


@router.get("/can-record", response_model=CanRecordOut)
def can_record_here(
    p: Principal = Depends(require_device),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> CanRecordOut:
    from app.storage.sites import can_record

    site = db.get(Site, p.site_id)
    assert site is not None
    if can_record(site):
        return CanRecordOut(can_record=True, reason=None)
    connected = site.storage_kind in ("s3", "azure") and bool(site.storage_config)
    return CanRecordOut(can_record=False, reason="storage_failing" if connected else "storage_not_connected")


@router.post("", response_model=SessionOut, status_code=201)
def create_session(
    body: SessionIn,
    p: Principal = Depends(require_device),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> SessionOut:
    existing = db.scalar(
        select(Session).where(
            Session.device_id == p.device.id, Session.client_session_id == body.client_session_id
        )
    )
    if existing:
        return SessionOut(
            id=existing.id,
            client_session_id=existing.client_session_id,
            encryption_key=_key_out(db, existing),
        )
    site = db.get(Site, p.site_id)
    assert site is not None
    require_storage(site)  # decision 044: no recording before the hospital's own storage is connected
    patient = _patient_for(db, p, body.patient)
    from app.api.clinic_consent import attach_to_session

    request_id = _request_for(db, p, patient, body.request_id)
    consent = attach_to_session(db, p, request_id, body.consent_id)
    key_id, pem, owner = session_key(db, site)
    s = Session(
        client_session_id=body.client_session_id,
        patient_id=patient.id,
        operator_id=p.operator.id if p.operator else None,
        recorded_by="patient" if p.kind == "patient" else "operator",
        device_id=p.device.id,
        started_at=body.started_at,
        med_state=body.med_state,
        app_version=body.app_version,
        config_versions=body.config_versions,
        consent_version=body.consent_version,
        consent_at=body.consent_at,
        key_id=key_id,
        request_id=request_id,
        consent_source=consent.source if consent else None,
        consent_reason=consent.reason if consent else None,
        consent_id=consent.id if consent else None,
    )
    db.add(s)
    db.flush()
    if consent:
        consent.session_id = s.id
    audit(
        db, p.actor_type, p.actor_id, "session_created", "session", s.id, site_id=p.site_id, key_owner=owner
    )
    db.commit()
    return SessionOut(
        id=s.id,
        client_session_id=s.client_session_id,
        encryption_key=EncryptionKey(key_id=key_id, public_key_pem=pem, owner=owner),
    )


def _request_for(db: DbSession, p: Principal, patient: Patient, request_id: str | None) -> str | None:
    """A request of this patient that is not cancelled (late recordings still count)."""
    if request_id is None:
        return None
    from app.models import RecordingRequest

    r = db.get(RecordingRequest, request_id)
    if not r or r.patient_id != patient.id or r.status == "cancelled":
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "unknown_request"})
    return r.id


class AbortIn(BaseModel):
    reason: str = Field(pattern=r"^[a-z_]+$")
    note: str | None = Field(default=None, max_length=500)


class OutcomeIn(BaseModel):
    """One planned test as it ended (M9 audit). Reason codes only: free-text notes stay on the phone."""

    test_code: str = Field(pattern=r"^(FT|FTF|FR|SAW|FA)$")
    side: str | None = Field(default=None, pattern=r"^[RL]$")
    status: str = Field(pattern=r"^(accepted|kept|skipped|pending)$")
    reason: str | None = Field(default=None, pattern=r"^[a-z_]+$")
    client_take_id: str | None = Field(default=None, max_length=64)
    at: datetime | None = None


class SessionClose(BaseModel):
    ended_at: datetime
    aborted: AbortIn | None = None
    outcomes: list[OutcomeIn] = Field(default_factory=list, max_length=20)
    #: Measured fps of every take recorded, retakes included (numbers only; Phones list).
    attempt_fps: list[Annotated[float, Field(ge=0, le=240)]] | None = Field(default=None, max_length=200)


@router.patch("/{session_id}", response_model=SessionOut)
@router.post("/{session_id}/close", response_model=SessionOut)  # for clients without PATCH (Android)
def close_session(
    session_id: str,
    body: SessionClose,
    p: Principal = Depends(require_device),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> SessionOut:
    s = db.get(Session, session_id)
    if not s or s.device_id != p.device.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "session not found")
    s.ended_at = body.ended_at
    s.aborted = body.aborted.model_dump() if body.aborted else None
    if body.attempt_fps is not None:
        s.attempt_fps = [round(f, 2) for f in body.attempt_fps]
    counts: dict[str, int] = {}
    for o in body.outcomes:
        counts[o.status] = counts.get(o.status, 0) + 1
        if o.status in ("skipped", "kept"):
            audit(
                db,
                p.actor_type,
                p.actor_id,
                "test_skipped" if o.status == "skipped" else "take_kept",
                "session",
                s.id,
                test_code=o.test_code,
                side=o.side,
                reason=o.reason,
                client_take_id=o.client_take_id,
                at=o.at.isoformat() if o.at else None,
                site_id=p.site_id,
            )
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "session_closed",
        "session",
        s.id,
        aborted=body.aborted.reason if body.aborted else None,
        outcomes=counts,
        site_id=p.site_id,
    )
    db.commit()
    return SessionOut(id=s.id, client_session_id=s.client_session_id)
