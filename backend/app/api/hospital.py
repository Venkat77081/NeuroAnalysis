"""Hospital admin (PLATFORM_PLAN M10): team (operators, doctors, other admins), phones and patient
invites, all scoped to the admin's own hospital. Patients exist here only as NCIDs; names, MRNs
and contact details stay in the hospital's records (decision 023)."""

import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.api.platform import AuditOut, Email, audit_rows
from app.api.staff import new_staff_invite
from app.audit import audit
from app.config import get_settings
from app.db import get_db
from app.models import (
    Device,
    DeviceEnrollment,
    Operator,
    Patient,
    PatientAccount,
    PatientRefreshToken,
    RefreshToken,
    Site,
    StaffRefreshToken,
    StaffUser,
)
from app.permissions import require
from app.policy import policy
from app.providers import staff_invite
from app.security import Principal, hash_password, new_secret, require_role, sha256_hex, temporary_password

router = APIRouter(prefix="/hospital", tags=["hospital"])
perm_setup_team = require("setup.team")
perm_setup_phones = require("setup.phones")
perm_setup_activity = require("setup.activity")
perm_invites_send = require("invites.send")
hospital_admin = require_role("hospital_admin")
#: Decision 031: patients, join invites and appointments are the front desk's; the hospital admin
#: sets the hospital up (team, phones, connector, storage).
front_desk = require_role("receptionist")


def site_of(db: DbSession, p: Principal) -> Site:
    site = db.get(Site, p.site_id) if p.site_id else None
    if not site:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "hospital not found")
    return site


class SiteOut(BaseModel):
    id: str
    name: str
    kind: str
    status: str
    data_mode: str
    modules: dict
    sms_enabled: bool


@router.get("", response_model=SiteOut)
def overview(p: Principal = Depends(hospital_admin), db: DbSession = Depends(get_db)) -> SiteOut:  # noqa: B008
    s = site_of(db, p)
    return SiteOut(
        id=s.id,
        name=s.name,
        kind=s.kind,
        status=s.status,
        data_mode=s.data_mode,
        modules=s.modules or {},
        sms_enabled=s.sms_enabled,
    )


# --- Operators (clinic phones: operator ID + password) ---


class OperatorIn(BaseModel):
    code: str = Field(min_length=2, max_length=20, pattern=r"^[A-Za-z0-9-]+$")
    #: The person's name, for the activity log.
    name: str | None = Field(default=None, min_length=2, max_length=120)
    role: Literal["operator", "reviewer"] = "operator"


class OperatorOut(BaseModel):
    id: str
    code: str
    name: str | None = None
    role: str
    active: bool
    must_change_password: bool
    locked: bool = False
    #: Shown once, on create and reset only. The operator must change it at first sign-in.
    temporary_password: str | None = None


def _op_out(op: Operator, temp: str | None = None) -> OperatorOut:
    return OperatorOut(
        id=op.id,
        code=op.code,
        name=op.name,
        role=op.role,
        active=op.active,
        must_change_password=op.must_change_password,
        locked=op.failed_logins >= policy()["operators"]["maxFailedLogins"],
        temporary_password=temp,
    )


def _operator(db: DbSession, p: Principal, operator_id: str) -> Operator:
    op = db.get(Operator, operator_id)
    if not op or op.site_id != p.site_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "operator not found")
    return op


def _revoke_operator_tokens(db: DbSession, operator_id: str) -> None:
    for rt in db.scalars(select(RefreshToken).where(RefreshToken.operator_id == operator_id)):
        rt.revoked = True


@router.get("/operators", response_model=list[OperatorOut])
def list_operators(
    p: Principal = Depends(perm_setup_team),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> list[OperatorOut]:
    q = select(Operator).where(Operator.site_id == p.site_id).order_by(Operator.code)
    return [_op_out(o) for o in db.scalars(q)]


@router.post("/operators", response_model=OperatorOut, status_code=201)
def create_operator(
    body: OperatorIn,
    p: Principal = Depends(perm_setup_team),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> OperatorOut:
    code = body.code.upper()
    if db.scalar(select(Operator).where(Operator.site_id == p.site_id, Operator.code == code)):
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "operator_id_in_use"})
    temp = temporary_password()
    op = Operator(
        site_id=p.site_id,
        code=code,
        name=body.name.strip() if body.name else None,
        role=body.role,
        pin_hash=hash_password(temp),
        must_change_password=True,
    )
    db.add(op)
    db.flush()
    audit(
        db, p.actor_type, p.actor_id, "operator_created", "operator", op.id, site_id=p.site_id, role=body.role
    )
    db.commit()
    return _op_out(op, temp)


@router.post("/operators/{operator_id}/reset-password", response_model=OperatorOut)
def reset_operator(
    operator_id: str,
    p: Principal = Depends(perm_setup_team),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> OperatorOut:
    op = _operator(db, p, operator_id)
    temp = temporary_password()
    op.pin_hash = hash_password(temp)
    op.must_change_password = True
    op.failed_logins = 0
    _revoke_operator_tokens(db, op.id)
    audit(db, p.actor_type, p.actor_id, "operator_password_reset", "operator", op.id, site_id=p.site_id)
    db.commit()
    return _op_out(op, temp)


class ActiveIn(BaseModel):
    active: bool


@router.post("/operators/{operator_id}/active", response_model=OperatorOut)
def set_operator_active(
    operator_id: str,
    body: ActiveIn,
    p: Principal = Depends(perm_setup_team),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> OperatorOut:
    op = _operator(db, p, operator_id)
    op.active = body.active
    if body.active:
        op.failed_logins = 0  # enabling also unlocks
    if not body.active:
        _revoke_operator_tokens(db, op.id)
    action = "operator_enabled" if body.active else "operator_disabled"
    audit(db, p.actor_type, p.actor_id, action, "operator", op.id, site_id=p.site_id)
    db.commit()
    return _op_out(op)


# --- Dashboard staff (doctors, hospital admins) ---


class StaffIn(BaseModel):
    email: str = Email
    display_name: str | None = Field(default=None, max_length=120)
    role: Literal["doctor", "hospital_admin", "receptionist"] = "doctor"


class StaffOut(BaseModel):
    id: str
    email: str
    display_name: str | None
    role: str
    active: bool
    invited: bool
    locked: bool
    two_step_enabled: bool
    last_login_at: datetime | None = None


def _staff_out(u: StaffUser) -> StaffOut:
    return StaffOut(
        id=u.id,
        email=u.email,
        display_name=u.display_name,
        role=u.role,
        active=u.active,
        invited=u.password_hash is None,
        locked=u.failed_logins >= policy()["staff"]["maxFailedLogins"],
        two_step_enabled=u.totp_enabled,
        last_login_at=u.last_login_at,
    )


def _staff(db: DbSession, p: Principal, user_id: str) -> StaffUser:
    u = db.get(StaffUser, user_id)
    if not u or u.site_id != p.site_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user not found")
    return u


@router.get("/staff", response_model=list[StaffOut])
def list_staff(p: Principal = Depends(perm_setup_team), db: DbSession = Depends(get_db)) -> list[StaffOut]:  # noqa: B008
    q = select(StaffUser).where(StaffUser.site_id == p.site_id).order_by(StaffUser.role, StaffUser.email)
    return [_staff_out(u) for u in db.scalars(q)]


@router.post("/staff", response_model=StaffOut, status_code=201)
def invite_staff(
    body: StaffIn,
    p: Principal = Depends(perm_setup_team),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> StaffOut:
    email = body.email.strip().lower()
    if db.scalar(select(StaffUser).where(StaffUser.email == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "email_in_use"})
    u = StaffUser(
        site_id=p.site_id, role=body.role, email=email, display_name=body.display_name, created_by=p.actor_id
    )
    db.add(u)
    db.flush()
    link = new_staff_invite(u)
    audit(db, p.actor_type, p.actor_id, "staff_invited", "staff", u.id, site_id=p.site_id, role=body.role)
    db.commit()
    staff_invite(email, site_of(db, p).name, body.role, link, policy()["invites"]["staffTtlDays"])
    return _staff_out(u)


@router.post("/staff/{user_id}/active", response_model=StaffOut)
def set_staff_active(
    user_id: str,
    body: ActiveIn,
    p: Principal = Depends(perm_setup_team),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> StaffOut:
    """Disable, or enable (which also unlocks after too many wrong passwords)."""
    u = _staff(db, p, user_id)
    if u.id == p.actor_id and not body.active:
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "cannot_disable_self"})
    u.active = body.active
    if body.active:
        u.failed_logins = 0
    else:
        for rt in db.scalars(select(StaffRefreshToken).where(StaffRefreshToken.user_id == u.id)):
            rt.revoked = True
    action = "staff_enabled" if body.active else "staff_disabled"
    audit(db, p.actor_type, p.actor_id, action, "staff", u.id, site_id=p.site_id)
    db.commit()
    return _staff_out(u)


@router.post("/staff/{user_id}/resend-invite", status_code=204)
def resend_staff_invite(
    user_id: str,
    p: Principal = Depends(perm_setup_team),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> None:
    u = _staff(db, p, user_id)
    if u.password_hash is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "already_accepted"})
    link = new_staff_invite(u)
    audit(db, p.actor_type, p.actor_id, "staff_invited", "staff", u.id, site_id=p.site_id, role=u.role)
    db.commit()
    staff_invite(u.email, site_of(db, p).name, u.role, link, policy()["invites"]["staffTtlDays"])


# --- Phones ---

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


class DeviceCodeIn(BaseModel):
    label: str | None = Field(default=None, max_length=60)


class DeviceCodeOut(BaseModel):
    #: Shown once (and as a QR code) in the dashboard; typed or scanned on the phone.
    code: str
    expires_at: datetime
    label: str | None


@router.post("/device-codes", response_model=DeviceCodeOut, status_code=201)
def new_device_code(
    body: DeviceCodeIn,
    p: Principal = Depends(perm_setup_phones),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> DeviceCodeOut:
    inv = policy()["invites"]
    code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(inv["deviceCodeLength"]))
    exp = datetime.now(UTC) + timedelta(hours=inv["deviceCodeTtlHours"])
    enr = DeviceEnrollment(
        site_id=p.site_id, code_hash=sha256_hex(code), label=body.label, created_by=p.actor_id, expires_at=exp
    )
    db.add(enr)
    db.flush()
    audit(db, p.actor_type, p.actor_id, "device_code_created", "enrollment", enr.id, site_id=p.site_id)
    db.commit()
    return DeviceCodeOut(code=code, expires_at=exp, label=body.label)


class DeviceOut(BaseModel):
    id: str
    kind: str
    label: str | None
    model: str
    os_version: str
    tier: str | None
    registered_at: datetime
    revoked_at: datetime | None
    #: Camera check when the phone was added (frames per second).
    check_fps: float | None = None
    checked_at: datetime | None = None


@router.get("/devices", response_model=list[DeviceOut])
def list_devices(
    kind: Literal["clinic", "patient"] = "clinic",
    p: Principal = Depends(perm_setup_phones),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> list[DeviceOut]:
    q = (
        select(Device)
        .where(Device.site_id == p.site_id, Device.kind == kind)
        .order_by(Device.registered_at.desc())
    )
    return [
        DeviceOut(
            id=d.id,
            kind=d.kind,
            label=d.label,
            model=d.model,
            os_version=d.os_version,
            tier=d.tier,
            registered_at=d.registered_at,
            revoked_at=d.revoked_at,
            check_fps=d.check_fps,
            checked_at=d.checked_at,
        )
        for d in db.scalars(q)
    ]


@router.post("/devices/{device_id}/revoke", status_code=204)
def revoke_device(
    device_id: str,
    p: Principal = Depends(perm_setup_phones),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> None:
    dev = db.get(Device, device_id)
    if not dev or dev.site_id != p.site_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "device not found")
    dev.revoked_at = datetime.now(UTC)
    for rt in db.scalars(select(RefreshToken).where(RefreshToken.device_id == device_id)):
        rt.revoked = True
    for prt in db.scalars(select(PatientRefreshToken).where(PatientRefreshToken.device_id == device_id)):
        prt.revoked = True
    audit(db, p.actor_type, p.actor_id, "device_revoked", "device", device_id, site_id=p.site_id)
    db.commit()


# --- Patients (home recording) ---


class PatientInviteIn(BaseModel):
    """Printed QR invite from the dashboard. E-mail and SMS invites go through the hospital
    connector (it holds the contact details); the platform never accepts a patient's contact or
    MRN (decision 027). Unknown fields are refused."""

    model_config = ConfigDict(extra="forbid")
    channel: Literal["print"] = "print"
    year_of_birth: int | None = Field(default=None, ge=1900, le=2100)
    sex: Literal["F", "M", "X"] | None = None


class PatientInviteOut(BaseModel):
    ncid: str
    status: str
    channel: str
    expires_at: datetime
    #: Only for channel "print": the link to show as a QR code. E-mail / SMS links are only sent.
    invite_link: str | None = None


def _new_patient_invite(acc: PatientAccount, channel: str) -> tuple[str, datetime]:
    token = new_secret()
    exp = datetime.now(UTC) + timedelta(days=policy()["invites"]["patientTtlDays"])
    acc.invite_token_hash = sha256_hex(token)
    acc.invite_expires_at = exp
    acc.invite_channel = channel
    return get_settings().invite_link_base + token, exp


def end_patient_phone(db: DbSession, acc: PatientAccount) -> None:
    """Before a re-invite: the old PIN, phone and refresh tokens stop working."""
    acc.pin_hash = None
    acc.failed_pins = 0
    if acc.device_id:
        dev = db.get(Device, acc.device_id)
        if dev and dev.revoked_at is None:
            dev.revoked_at = datetime.now(UTC)
        acc.device_id = None
    for prt in db.scalars(select(PatientRefreshToken).where(PatientRefreshToken.account_id == acc.id)):
        prt.revoked = True


def _check_channel(site: Site, channel: str) -> None:
    if not (site.modules or {}).get("home", True):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "home_recording_off"})
    if channel == "sms" and not site.sms_enabled:
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "sms_not_enabled"})


@router.post("/patients/invite", response_model=PatientInviteOut, status_code=201)
def invite_patient(
    body: PatientInviteIn,
    p: Principal = Depends(perm_invites_send),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> PatientInviteOut:
    site = site_of(db, p)
    _check_channel(site, body.channel)
    patient = Patient(site_id=site.id, year_of_birth=body.year_of_birth, sex=body.sex)
    db.add(patient)
    db.flush()
    acc = PatientAccount(site_id=site.id, patient_id=patient.id, status="invited", created_by=p.actor_id)
    db.add(acc)
    link, exp = _new_patient_invite(acc, body.channel)
    db.flush()
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "patient_invited",
        "patient",
        patient.id,
        site_id=site.id,
        channel=body.channel,
    )
    db.commit()
    return PatientInviteOut(
        ncid=patient.ncid,
        status=acc.status,
        channel=body.channel,
        expires_at=exp,
        invite_link=link,
    )


def _account(db: DbSession, p: Principal, ncid: str) -> tuple[Patient, PatientAccount]:
    patient = db.scalar(select(Patient).where(Patient.ncid == ncid, Patient.site_id == p.site_id))
    acc = (
        db.scalar(select(PatientAccount).where(PatientAccount.patient_id == patient.id)) if patient else None
    )
    if not patient or not acc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient not found")
    return patient, acc


class ReinviteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    channel: Literal["print"] = "print"


@router.post("/patients/{ncid}/reinvite", response_model=PatientInviteOut)
def reinvite_patient(
    ncid: str,
    body: ReinviteIn,
    p: Principal = Depends(perm_invites_send),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> PatientInviteOut:
    """New invite (new phone, lost PIN, expired link). The old link and phone stop working."""
    site = site_of(db, p)
    _check_channel(site, body.channel)
    patient, acc = _account(db, p, ncid)
    link, exp = _new_patient_invite(acc, body.channel)
    acc.status = "invited"
    end_patient_phone(db, acc)
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "patient_reinvited",
        "patient",
        patient.id,
        site_id=site.id,
        channel=body.channel,
    )
    db.commit()
    return PatientInviteOut(
        ncid=patient.ncid,
        status=acc.status,
        channel=body.channel,
        expires_at=exp,
        invite_link=link,
    )


@router.post("/patients/{ncid}/close", status_code=204)
def close_patient(
    ncid: str,
    p: Principal = Depends(hospital_admin),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> None:
    """Stops home recording for this patient (their recordings stay with the hospital)."""
    patient, acc = _account(db, p, ncid)
    acc.status = "closed"
    acc.invite_token_hash = None
    for prt in db.scalars(select(PatientRefreshToken).where(PatientRefreshToken.account_id == acc.id)):
        prt.revoked = True
    if acc.device_id:
        dev = db.get(Device, acc.device_id)
        if dev and dev.revoked_at is None:
            dev.revoked_at = datetime.now(UTC)
    audit(db, p.actor_type, p.actor_id, "patient_closed", "patient", patient.id, site_id=p.site_id)
    db.commit()


class PatientOut(BaseModel):
    ncid: str
    #: invited | active | locked | closed (home app) or clinic (no app account)
    status: str
    invite_channel: str | None
    invite_expires_at: datetime | None
    consent_version: str | None
    created_at: datetime | None
    sessions: int = 0
    last_session_at: datetime | None = None
    #: M14: the doctor this patient is assigned to (staff user ID), if any.
    doctor_id: str | None = None
    #: The patient's phone failed the camera check and they told the hospital (record in clinic).
    phone_unsuitable_fps: float | None = None


@router.get("/patients", response_model=list[PatientOut])
def list_patients(
    p: Principal = Depends(require_role("hospital_admin", "doctor", "receptionist")),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> list[PatientOut]:
    """NCIDs, app status, session counts and the assigned doctor; the dashboard joins names and MRNs
    live from the hospital's records through the connector. Doctors see only their own patients."""
    from sqlalchemy import func

    from app.models import PatientAssignment, Session

    stats = (
        select(Session.patient_id, func.count().label("n"), func.max(Session.started_at).label("last"))
        .group_by(Session.patient_id)
        .subquery()
    )
    q = (
        select(Patient, PatientAccount, stats.c.n, stats.c.last, PatientAssignment.doctor_id)
        .outerjoin(PatientAccount, PatientAccount.patient_id == Patient.id)
        .outerjoin(stats, stats.c.patient_id == Patient.id)
        .outerjoin(PatientAssignment, PatientAssignment.patient_id == Patient.id)
        .where(Patient.site_id == p.site_id)
        .order_by(stats.c.last.desc().nulls_last(), PatientAccount.created_at.desc().nulls_last())
    )
    return [
        PatientOut(
            ncid=pt.ncid,
            status=acc.status if acc else "clinic",
            invite_channel=acc.invite_channel if acc else None,
            invite_expires_at=acc.invite_expires_at if acc else None,
            consent_version=acc.consent_version if acc else None,
            created_at=acc.created_at if acc else None,
            sessions=n or 0,
            last_session_at=last,
            doctor_id=doc,
            phone_unsuitable_fps=acc.camera_failed_fps if acc else None,
        )
        for pt, acc, n, last, doc in db.execute(q)
        if p.role != "doctor" or doc == p.actor_id
    ]


@router.get("/audit", response_model=list[AuditOut])
def hospital_audit(
    limit: int = Query(200, ge=1, le=1000),
    p: Principal = Depends(perm_setup_activity),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> list[AuditOut]:
    return audit_rows(db, p.site_id, limit)


@router.get("/permissions")
def my_permissions(p: Principal = Depends(hospital_admin), db: DbSession = Depends(get_db)):  # noqa: B008
    """The hospital admin sees who can do what here (read only; set by the platform admin)."""
    from app.api.platform import permissions_out

    return permissions_out(db, site_of(db, p))
