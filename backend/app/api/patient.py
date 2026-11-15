"""Patient app (PLATFORM_PLAN M10): accept the hospital's invite on the patient's own phone, set a
PIN, then sign in with the PIN. The patient is known only by NCID; no MRN is asked for."""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.api.auth import ServerKey
from app.audit import audit
from app.config import get_settings
from app.db import get_db
from app.keys import server_public_key
from app.models import Device, Patient, PatientAccount, PatientRefreshToken, Site
from app.policy import policy
from app.security import (
    Principal,
    create_patient_token,
    current_principal,
    hash_pin,
    new_secret,
    sha256_hex,
    verify_pin,
)

router = APIRouter(prefix="/patient", tags=["patient"])


def _aware(dt: datetime | None) -> datetime | None:
    return dt if dt is None or dt.tzinfo else dt.replace(tzinfo=UTC)


def _pin_ok(pin: str) -> bool:
    rule = policy()["patientPin"]
    return pin.isdigit() and rule["minDigits"] <= len(pin) <= rule["maxDigits"]


class PatientTokens(BaseModel):
    access_token: str
    refresh_token: str
    expires_in: int


def _issue(db: DbSession, acc: PatientAccount, dev: Device) -> PatientTokens:
    access, ttl = create_patient_token(acc, dev)
    refresh = new_secret()
    db.add(
        PatientRefreshToken(
            account_id=acc.id,
            device_id=dev.id,
            token_hash=sha256_hex(refresh),
            expires_at=datetime.now(UTC) + timedelta(seconds=get_settings().refresh_ttl_s),
        )
    )
    return PatientTokens(access_token=access, refresh_token=refresh, expires_in=ttl)


class InviteInfo(BaseModel):
    hospital: str
    kind: str
    consent_version: str
    pin_min_digits: int
    pin_max_digits: int


class InviteLookupIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)


def _invited(db: DbSession, token: str) -> tuple[PatientAccount, Site]:
    acc = db.scalar(select(PatientAccount).where(PatientAccount.invite_token_hash == sha256_hex(token)))
    exp = _aware(acc.invite_expires_at) if acc else None
    site = db.get(Site, acc.site_id) if acc else None
    if not acc or acc.status != "invited" or exp is None or exp < datetime.now(UTC) or not site:
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "invite_invalid"})
    if site.status == "suspended":
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "hospital_suspended"})
    return acc, site


@router.post("/invite/lookup", response_model=InviteInfo)
def invite_lookup(body: InviteLookupIn, db: DbSession = Depends(get_db)) -> InviteInfo:  # noqa: B008
    """What the app shows before the PIN screen: which hospital invited the patient."""
    _, site = _invited(db, body.token)
    rule = policy()["patientPin"]
    return InviteInfo(
        hospital=site.name,
        kind=site.kind,
        consent_version=policy()["consentVersion"],
        pin_min_digits=rule["minDigits"],
        pin_max_digits=rule["maxDigits"],
    )


class AcceptIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    pin: str = Field(min_length=1, max_length=12)
    consent_version: str = Field(max_length=50)
    model: str = Field(max_length=100)
    os_version: str = Field(max_length=50)


class AcceptOut(BaseModel):
    device_id: str
    device_secret: str
    site_id: str
    hospital: str
    ncid: str
    server_key: ServerKey
    tokens: PatientTokens


@router.post("/invite/accept", response_model=AcceptOut, status_code=201)
def invite_accept(body: AcceptIn, db: DbSession = Depends(get_db)) -> AcceptOut:  # noqa: B008
    acc, site = _invited(db, body.token)
    if not _pin_ok(body.pin):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "pin_format"})
    if body.consent_version != policy()["consentVersion"]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "consent_version"})
    secret = new_secret()
    dev = Device(
        site_id=site.id,
        model=body.model,
        os_version=body.os_version,
        secret_hash=sha256_hex(secret),
        kind="patient",
    )
    db.add(dev)
    db.flush()
    now_ = datetime.now(UTC)
    acc.status = "active"
    acc.pin_hash = hash_pin(body.pin)
    acc.failed_pins = 0
    acc.device_id = dev.id
    acc.consent_version = body.consent_version
    acc.consent_at = now_
    acc.invite_token_hash = None
    acc.invite_expires_at = None
    tokens = _issue(db, acc, dev)
    patient = db.get(Patient, acc.patient_id)
    assert patient is not None
    audit(
        db,
        "patient",
        acc.id,
        "patient_invite_accepted",
        "device",
        dev.id,
        site_id=site.id,
        consent_version=body.consent_version,
    )
    db.commit()
    key_id, pem = server_public_key()
    return AcceptOut(
        device_id=dev.id,
        device_secret=secret,
        site_id=site.id,
        hospital=site.name,
        ncid=patient.ncid,
        server_key=ServerKey(key_id=key_id, public_key_pem=pem),
        tokens=tokens,
    )


class LoginIn(BaseModel):
    device_id: str
    device_secret: str
    pin: str = Field(min_length=1, max_length=12)


@router.post("/login", response_model=PatientTokens)
def login(body: LoginIn, db: DbSession = Depends(get_db)) -> PatientTokens:  # noqa: B008
    dev = db.get(Device, body.device_id)
    if (
        not dev
        or dev.kind != "patient"
        or dev.revoked_at is not None
        or dev.secret_hash != sha256_hex(body.device_secret)
    ):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "phone not registered or removed")
    acc = db.scalar(select(PatientAccount).where(PatientAccount.device_id == dev.id))
    site = db.get(Site, dev.site_id)
    if not acc or not site:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "phone not registered or removed")
    if site.status == "suspended":
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "hospital_suspended"})
    if acc.status == "locked":
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "pin_locked"})
    if acc.status != "active":
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "account_closed"})
    if not verify_pin(body.pin, acc.pin_hash):
        acc.failed_pins += 1
        audit(db, "patient", acc.id, "patient_login_failed", site_id=acc.site_id, attempt=acc.failed_pins)
        if acc.failed_pins >= policy()["patientPin"]["maxFailures"]:
            acc.status = "locked"
            audit(db, "system", None, "patient_locked", "patient", acc.patient_id, site_id=acc.site_id)
            db.commit()
            raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "pin_locked"})
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong PIN")
    acc.failed_pins = 0
    out = _issue(db, acc, dev)
    audit(db, "patient", acc.id, "patient_login", "device", dev.id, site_id=acc.site_id)
    db.commit()
    return out


class RefreshIn(BaseModel):
    refresh_token: str


@router.post("/refresh", response_model=PatientTokens)
def refresh(body: RefreshIn, db: DbSession = Depends(get_db)) -> PatientTokens:  # noqa: B008
    rt = db.scalar(
        select(PatientRefreshToken).where(PatientRefreshToken.token_hash == sha256_hex(body.refresh_token))
    )
    exp = _aware(rt.expires_at) if rt else None
    if not rt or rt.revoked or exp is None or exp < datetime.now(UTC):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "refresh token invalid")
    acc = db.get(PatientAccount, rt.account_id)
    dev = db.get(Device, rt.device_id)
    site = db.get(Site, dev.site_id) if dev else None
    if (
        not acc
        or acc.status != "active"
        or not dev
        or dev.revoked_at is not None
        or acc.device_id != dev.id
        or not site
        or site.status == "suspended"
    ):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "account or phone not allowed")
    rt.revoked = True
    out = _issue(db, acc, dev)
    db.commit()
    return out


class MeOut(BaseModel):
    ncid: str
    hospital: str
    status: str
    consent_version: str | None


@router.get("/me", response_model=MeOut)
def me(p: Principal = Depends(current_principal), db: DbSession = Depends(get_db)) -> MeOut:  # noqa: B008
    if p.patient is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "patient sign-in required")
    patient = db.get(Patient, p.patient.patient_id)
    site = db.get(Site, p.patient.site_id)
    assert patient is not None and site is not None
    return MeOut(
        ncid=patient.ncid,
        hospital=site.name,
        status=p.patient.status,
        consent_version=p.patient.consent_version,
    )
