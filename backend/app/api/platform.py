"""Platform admin (PLATFORM_PLAN M10): onboard hospitals and clinics, suspend them, read the
platform activity log. NeuroCapture's own database holds only this: who the hospitals are, who
onboarded them, and admin activity (decision 023)."""

import secrets
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from app.api.staff import new_staff_invite
from app.audit import audit
from app.db import get_db
from app.models import AuditEvent, Device, Operator, PatientAccount, Site, StaffUser
from app.policy import policy
from app.providers import staff_invite
from app.security import Principal, require_role, sha256_hex

router = APIRouter(prefix="/platform", tags=["platform"])
admin_only = require_role("platform_admin")

Email = Field(min_length=3, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class Modules(BaseModel):
    clinic: bool = True
    home: bool = True


class HospitalIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    kind: Literal["hospital", "clinic"] = "hospital"
    region: str = Field(min_length=2, max_length=50)
    city: str | None = Field(default=None, max_length=100)
    data_mode: Literal["byo", "managed"] = "managed"
    modules: Modules = Modules()
    sms_enabled: bool = False
    admin_email: str = Email
    admin_name: str | None = Field(default=None, max_length=120)


class HospitalOut(BaseModel):
    id: str
    name: str
    kind: str
    region: str
    city: str | None
    data_mode: str
    status: str
    modules: dict
    sms_enabled: bool
    onboarded_by: str | None
    onboarded_at: datetime | None
    devices: int = 0
    operators: int = 0
    staff: int = 0
    patients: int = 0


def _out(db: DbSession, site: Site) -> HospitalOut:
    def count(model, *where) -> int:
        return db.scalar(select(func.count()).select_from(model).where(model.site_id == site.id, *where)) or 0

    return HospitalOut(
        id=site.id,
        name=site.name,
        kind=site.kind,
        region=site.region,
        city=site.city,
        data_mode=site.data_mode,
        status=site.status,
        modules=site.modules or {},
        sms_enabled=site.sms_enabled,
        onboarded_by=site.onboarded_by,
        onboarded_at=site.onboarded_at,
        devices=count(Device, Device.revoked_at.is_(None)),
        operators=count(Operator, Operator.active.is_(True)),
        staff=count(StaffUser, StaffUser.active.is_(True)),
        patients=count(PatientAccount, PatientAccount.status == "active"),
    )


@router.post("/hospitals", response_model=HospitalOut, status_code=201)
def onboard(
    body: HospitalIn,
    p: Principal = Depends(admin_only),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> HospitalOut:
    email = body.admin_email.strip().lower()
    if db.scalar(select(StaffUser).where(StaffUser.email == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "email_in_use"})
    site = Site(
        name=body.name,
        kind=body.kind,
        region=body.region,
        city=body.city,
        data_mode=body.data_mode,
        modules=body.modules.model_dump(),
        sms_enabled=body.sms_enabled,
        status="invited",
        # Standing code is never shown: phones join with one-time codes from the dashboard.
        enrollment_code_hash=sha256_hex(secrets.token_urlsafe(32)),
        patient_ref_salt=secrets.token_hex(16),
        onboarded_by=p.actor_id,
        onboarded_at=datetime.now(UTC),
    )
    db.add(site)
    db.flush()
    admin = StaffUser(
        site_id=site.id,
        role="hospital_admin",
        email=email,
        display_name=body.admin_name,
        created_by=p.actor_id,
    )
    db.add(admin)
    db.flush()
    link = new_staff_invite(admin)
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "hospital_onboarded",
        "site",
        site.id,
        site_id=site.id,
        data_mode=body.data_mode,
        kind=body.kind,
    )
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "staff_invited",
        "staff",
        admin.id,
        site_id=site.id,
        role="hospital_admin",
    )
    db.commit()
    staff_invite(email, site.name, "hospital_admin", link, policy()["invites"]["staffTtlDays"])
    return _out(db, site)


@router.get("/hospitals", response_model=list[HospitalOut])
def list_hospitals(
    _: Principal = Depends(admin_only),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> list[HospitalOut]:
    return [_out(db, s) for s in db.scalars(select(Site).order_by(Site.name))]


def _site(db: DbSession, site_id: str) -> Site:
    site = db.get(Site, site_id)
    if not site:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "hospital not found")
    return site


class StatusIn(BaseModel):
    status: Literal["active", "suspended"]


@router.post("/hospitals/{site_id}/status", response_model=HospitalOut)
def set_status(
    site_id: str,
    body: StatusIn,
    p: Principal = Depends(admin_only),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> HospitalOut:
    """Suspend: the hospital's phones, operators, patients and dashboard users are refused."""
    site = _site(db, site_id)
    site.status = body.status
    audit(db, p.actor_type, p.actor_id, f"hospital_{body.status}", "site", site.id, site_id=site.id)
    db.commit()
    return _out(db, site)


@router.post("/hospitals/{site_id}/resend-admin-invite", status_code=204)
def resend_admin_invite(
    site_id: str,
    p: Principal = Depends(admin_only),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> None:
    site = _site(db, site_id)
    admin = db.scalar(
        select(StaffUser)
        .where(StaffUser.site_id == site.id, StaffUser.role == "hospital_admin")
        .order_by(StaffUser.created_at)
    )
    if not admin:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no hospital admin")
    link = new_staff_invite(admin)
    admin.failed_logins = 0
    audit(db, p.actor_type, p.actor_id, "staff_invited", "staff", admin.id, site_id=site.id, role=admin.role)
    db.commit()
    staff_invite(admin.email, site.name, admin.role, link, policy()["invites"]["staffTtlDays"])


class AuditOut(BaseModel):
    at: datetime
    site_id: str | None
    actor_type: str
    actor_id: str | None
    action: str
    target_type: str | None
    target_id: str | None
    details: dict | None


def audit_rows(db: DbSession, site_id: str | None, limit: int, platform_only: bool = False) -> list[AuditOut]:
    q = select(AuditEvent).order_by(AuditEvent.at.desc()).limit(limit)
    if site_id is not None:
        q = q.where(AuditEvent.site_id == site_id)
    elif platform_only:
        q = q.where(AuditEvent.site_id.is_(None))
    return [
        AuditOut(
            at=e.at,
            site_id=e.site_id,
            actor_type=e.actor_type,
            actor_id=e.actor_id,
            action=e.action,
            target_type=e.target_type,
            target_id=e.target_id,
            details=e.details,
        )
        for e in db.scalars(q)
    ]


@router.get("/audit", response_model=list[AuditOut])
def platform_audit(
    site_id: str | None = None,
    limit: int = Query(200, ge=1, le=1000),
    _: Principal = Depends(admin_only),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> list[AuditOut]:
    """Platform admin activity and hospital onboarding events. Clinical activity logs belong to
    the hospital (their database once the connector is configured)."""
    return audit_rows(db, site_id, limit)


class SetupOut(BaseModel):
    """Onboarding wizard status for one hospital: pass / fail facts only, never data."""

    admin_accepted: bool
    connector_registered: bool
    connector_check: dict | None
    storage_kind: str
    storage_check: dict | None
    take_key: bool
    devices: int
    operators: int
    doctors: int


@router.get("/hospitals/{site_id}/setup", response_model=SetupOut)
def hospital_setup(
    site_id: str,
    _: Principal = Depends(admin_only),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> SetupOut:
    from app.models import SiteKey

    site = _site(db, site_id)
    staff = list(db.scalars(select(StaffUser).where(StaffUser.site_id == site.id)))
    out = _out(db, site)
    return SetupOut(
        admin_accepted=any(u.role == "hospital_admin" and u.password_hash for u in staff),
        connector_registered=bool(site.connector_public_key),
        connector_check=site.connector_check,
        storage_kind=site.storage_kind,
        storage_check=site.storage_check,
        take_key=db.scalar(select(SiteKey).where(SiteKey.site_id == site.id, SiteKey.status == "active"))
        is not None,
        devices=out.devices,
        operators=out.operators,
        doctors=sum(1 for u in staff if u.role == "doctor" and u.active),
    )
