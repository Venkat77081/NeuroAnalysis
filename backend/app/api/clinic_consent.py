"""v16 (decision 047): consent for clinic recordings.

- The patient agrees in their app for one clinic recording request. The platform returns a
  one-time code (shown as a QR, with the code in letters below it), valid until the end of the
  visit day in the hospital's time zone. Only its hash is kept; it holds no identity.
- At the visit, the clinic phone scans it: right hospital, right request, today, not used, not
  withdrawn. The consent is then "used" and the session that follows records it.
- A patient without the app (or who cannot show the code) may consent on the clinic phone, with a
  reason, when the hospital allows it (`clinic_phone_consent`).
- A clinic phone's session for a clinic request needs one of the two (`consent_id`).
"""

import secrets
from datetime import UTC, datetime, time, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.api.requests import aware, request_state
from app.audit import audit
from app.db import get_db
from app.hospital_settings import site_settings, site_tz
from app.models import Appointment, ClinicConsent, PatientAccount, RecordingRequest, Site
from app.permissions import require
from app.policy import policy
from app.security import Principal, current_principal, sha256_hex

router = APIRouter(tags=["clinic consent"])
operator_queue = require("clinic.record")
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def _cfg() -> dict:
    return policy()["clinicConsent"]


def _bad(code: str, http: int = status.HTTP_409_CONFLICT) -> HTTPException:
    return HTTPException(http, {"code": code})


def normalize(text: str) -> str:
    """ "ncc1:ABCD…", "abcd-efgh-…" → "ABCDEFGH…"."""
    t = text.strip()
    prefix = _cfg()["qrPrefix"]
    if t.lower().startswith(prefix):
        t = t[len(prefix) :]
    return "".join(ch for ch in t.upper() if ch.isalnum())


def _visit_end(db: DbSession, site: Site, r: RecordingRequest) -> datetime:
    a = db.get(Appointment, r.appointment_id) if r.appointment_id else None
    when = aware(a.at) if a else aware(r.due_at)
    tz = site_tz(site)
    day = when.astimezone(tz).date()
    return datetime.combine(day + timedelta(days=1), time(0), tzinfo=tz).astimezone(UTC)


def _clinic_request(db: DbSession, req_id: str, site_id: str) -> RecordingRequest:
    r = db.get(RecordingRequest, req_id)
    if not r or r.site_id != site_id or r.place != "clinic" or r.status == "cancelled":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "request not found")
    return r


def consent_state(db: DbSession, r: RecordingRequest) -> dict:
    """For the clinic queue: app_given | waiting (in the app, not agreed yet) | no_app; plus
    whether the hospital allows consent on the clinic phone."""
    now_ = datetime.now(UTC)
    c = db.scalar(
        select(ClinicConsent)
        .where(
            ClinicConsent.request_id == r.id,
            ClinicConsent.status == "active",
            ClinicConsent.source == "patient_app",
        )
        .order_by(ClinicConsent.agreed_at.desc())
        .limit(1)
    )
    acc = db.scalar(select(PatientAccount).where(PatientAccount.patient_id == r.patient_id))
    in_app = bool(acc and acc.status == "active")
    if c and aware(c.valid_until) > now_:
        state = "app_given"
    else:
        state = "waiting" if in_app else "no_app"
    return {
        "state": state,
        "phone_allowed": bool(site_settings(db.get(Site, r.site_id))["clinic_phone_consent"]),
    }


# --- The patient's app ---


class PatientConsentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    consent_version: str = Field(max_length=50)


class PatientConsentOut(BaseModel):
    #: Shown once: the app keeps it to show the QR (the platform keeps only its hash).
    code: str
    qr: str
    agreed_at: datetime
    valid_until: datetime


@router.post("/patient/requests/{req_id}/clinic-consent", response_model=PatientConsentOut, status_code=201)
def give_consent(
    req_id: str,
    body: PatientConsentIn,
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> PatientConsentOut:
    if p.patient is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "patient sign-in required")
    r = _clinic_request(db, req_id, p.patient.site_id)
    if r.patient_id != p.patient.patient_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "request not found")
    if body.consent_version != policy()["consentVersion"]:
        raise _bad("consent_version", status.HTTP_422_UNPROCESSABLE_ENTITY)
    if request_state(db, r) != "open":
        raise _bad("request_not_open")
    site = db.get(Site, r.site_id)
    until = _visit_end(db, site, r)
    if until <= datetime.now(UTC):
        raise _bad("visit_over")
    for old in db.scalars(
        select(ClinicConsent).where(ClinicConsent.request_id == r.id, ClinicConsent.status == "active")
    ):
        old.status = "withdrawn"
    code = "".join(secrets.choice(ALPHABET) for _ in range(int(_cfg()["codeLength"])))
    c = ClinicConsent(
        site_id=r.site_id,
        patient_id=r.patient_id,
        request_id=r.id,
        source="patient_app",
        code_hash=sha256_hex(code),
        consent_version=body.consent_version,
        valid_until=until,
    )
    db.add(c)
    db.flush()
    audit(
        db,
        "patient",
        p.actor_id,
        "clinic_consent_given",
        "patient",
        r.patient_id,
        site_id=r.site_id,
        via="app",
    )
    db.commit()
    return PatientConsentOut(
        code=code, qr=f"{_cfg()['qrPrefix']}{code}", agreed_at=c.agreed_at, valid_until=until
    )


@router.post("/patient/requests/{req_id}/clinic-consent/withdraw", status_code=204)
def withdraw_consent(
    req_id: str,
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> None:
    if p.patient is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "patient sign-in required")
    r = _clinic_request(db, req_id, p.patient.site_id)
    if r.patient_id != p.patient.patient_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "request not found")
    n = 0
    for c in db.scalars(
        select(ClinicConsent).where(ClinicConsent.request_id == r.id, ClinicConsent.status == "active")
    ):
        c.status = "withdrawn"
        n += 1
    if not n:
        raise _bad("no_consent")
    audit(db, "patient", p.actor_id, "clinic_consent_withdrawn", "patient", r.patient_id, site_id=r.site_id)
    db.commit()


# --- The clinic phone ---


class ConfirmedOut(BaseModel):
    consent_id: str
    #: patient_app | clinic_phone
    source: str
    agreed_at: datetime
    consent_version: str
    reason: str | None = None


class ScanIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: What the QR holds ("ncc1:…") or the code typed from below it.
    code: str = Field(min_length=6, max_length=80)


@router.post("/clinic/requests/{req_id}/consent-scan", response_model=ConfirmedOut)
def scan(
    req_id: str,
    body: ScanIn,
    p: Principal = Depends(operator_queue),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> ConfirmedOut:
    """Checks the patient's code for this request: wrong_patient | expired | withdrawn | used."""
    r = _clinic_request(db, req_id, p.site_id)
    c = db.scalar(select(ClinicConsent).where(ClinicConsent.code_hash == sha256_hex(normalize(body.code))))
    if c is None or c.site_id != p.site_id:
        raise _bad("consent_unknown")
    if c.request_id != r.id:
        raise _bad("wrong_patient")
    if c.status == "withdrawn":
        raise _bad("consent_withdrawn")
    if c.status == "used":
        raise _bad("consent_used")
    if aware(c.valid_until) <= datetime.now(UTC):
        raise _bad("consent_expired")
    c.status, c.used_at, c.used_by = "used", datetime.now(UTC), p.actor_id
    audit(db, p.actor_type, p.actor_id, "clinic_consent_scanned", "patient", r.patient_id, site_id=p.site_id)
    db.commit()
    return ConfirmedOut(
        consent_id=c.id, source=c.source, agreed_at=c.agreed_at, consent_version=c.consent_version
    )


class PhoneConsentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str = Field(max_length=24)
    consent_version: str = Field(max_length=50)


@router.post("/clinic/requests/{req_id}/consent-on-phone", response_model=ConfirmedOut)
def on_phone(
    req_id: str,
    body: PhoneConsentIn,
    p: Principal = Depends(operator_queue),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> ConfirmedOut:
    """The patient read and agreed on the clinic phone (no app, or cannot show the code)."""
    r = _clinic_request(db, req_id, p.site_id)
    site = db.get(Site, p.site_id)
    if not site_settings(site)["clinic_phone_consent"]:
        raise _bad("phone_consent_off")
    if body.reason not in _cfg()["fallbackReasons"]:
        raise _bad("reason_unknown", status.HTTP_422_UNPROCESSABLE_ENTITY)
    now_ = datetime.now(UTC)
    c = ClinicConsent(
        site_id=r.site_id,
        patient_id=r.patient_id,
        request_id=r.id,
        source="clinic_phone",
        reason=body.reason,
        consent_version=body.consent_version,
        agreed_at=now_,
        valid_until=_visit_end(db, site, r),
        status="used",
        used_at=now_,
        used_by=p.actor_id,
    )
    db.add(c)
    db.flush()
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "clinic_consent_given",
        "patient",
        r.patient_id,
        site_id=p.site_id,
        via="clinic_phone",
        reason=body.reason,
    )
    db.commit()
    return ConfirmedOut(
        consent_id=c.id,
        source=c.source,
        agreed_at=c.agreed_at,
        consent_version=c.consent_version,
        reason=c.reason,
    )


def attach_to_session(
    db: DbSession, p: Principal, request_id: str | None, consent_id: str | None
) -> ClinicConsent | None:
    """A clinic phone's session for a clinic request needs a confirmed consent for it (not used by
    another session). Patients' own sessions and sessions without a clinic request need none."""
    if p.kind != "operator" or not request_id:
        return None
    r = db.get(RecordingRequest, request_id)
    if not r or r.place != "clinic":
        return None
    c = db.get(ClinicConsent, consent_id) if consent_id else None
    if not c or c.request_id != r.id or c.status != "used" or c.session_id is not None:
        raise _bad("clinic_consent_required", status.HTTP_422_UNPROCESSABLE_ENTITY)
    return c
