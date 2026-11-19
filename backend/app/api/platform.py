"""Platform admin (PLATFORM_PLAN M10): onboard hospitals and clinics, suspend them, read the
platform activity log. NeuroCapture's own database holds only this: who the hospitals are, who
onboarded them, and admin activity (decision 023)."""

import secrets
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from app.api.staff import ResetOut, deliver_staff_invite, new_staff_invite, reset_sign_in
from app.audit import audit
from app.config import get_settings
from app.connector_health import ConnectorHistoryOut, history, is_online, last_seen
from app.db import get_db
from app.models import AuditEvent, Device, Operator, PatientAccount, Site, StaffUser
from app.policy import policy
from app.security import Principal, require_role, sha256_hex
from app.storage.sites import can_record

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
    #: Decision 031: hospital-owned data only (the hospital runs its connector and holds its key).
    data_mode: Literal["byo"] = "byo"
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
    #: Decision 044: storage connected and passing.
    can_record: bool = False
    #: v29 (decision 052): the connector's last check-in and whether it counts as online
    #: (null: no connector registered).
    connector_last_seen_at: datetime | None = None
    connector_online: bool | None = None


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
        can_record=can_record(site),
        connector_last_seen_at=(seen := last_seen(db, site.id)),
        connector_online=is_online(seen) if site.connector_public_key else None,
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
        # Decision 044: no NeuroCapture storage. The hospital connects its own; test servers start on
        # the development storage so the demo stack can record.
        storage_kind="dev" if get_settings().dev_storage else "none",
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
    deliver_staff_invite(email, site.name, "hospital_admin", link, policy()["invites"]["staffTtlDays"])
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
    deliver_staff_invite(admin.email, site.name, admin.role, link, policy()["invites"]["staffTtlDays"])


class AdminOut(BaseModel):
    id: str
    email: str
    display_name: str | None
    signed_up: bool
    last_login_at: datetime | None


@router.get("/hospitals/{site_id}/admins", response_model=list[AdminOut])
def hospital_admins(
    site_id: str,
    _: Principal = Depends(admin_only),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> list[AdminOut]:
    site = _site(db, site_id)
    rows = db.scalars(
        select(StaffUser)
        .where(StaffUser.site_id == site.id, StaffUser.role == "hospital_admin")
        .order_by(StaffUser.created_at)
    )
    return [
        AdminOut(
            id=u.id,
            email=u.email,
            display_name=u.display_name,
            signed_up=u.password_hash is not None,
            last_login_at=u.last_login_at,
        )
        for u in rows
    ]


class PlatformResetIn(BaseModel):
    reason: str = Field(pattern=r"^[a-z_]+$")


@router.post("/staff/{user_id}/reset-sign-in", response_model=ResetOut)
def reset_admin_sign_in(
    user_id: str,
    body: PlatformResetIn,
    p: Principal = Depends(admin_only),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> ResetOut:
    """Decision 039: the platform admin resets a hospital admin, or another platform admin."""
    u = db.get(StaffUser, user_id)
    if not u or u.role not in ("hospital_admin", "platform_admin"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "admin not found")
    if u.id == p.actor_id:
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "cannot_reset_self"})
    if u.password_hash is None and not u.totp_enabled:
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "not_signed_up"})
    from app.people import People

    return reset_sign_in(
        db, u, p.actor_type, p.actor_id, People(db).who(p.actor_type, p.actor_id).name, body.reason
    )


class AuditOut(BaseModel):
    at: datetime
    site_id: str | None
    actor_type: str
    actor_id: str | None
    action: str
    target_type: str | None
    target_id: str | None
    details: dict | None
    #: Who did it (user, 16 Nov 2026): the person's name, e-mail and role, not only the role.
    actor_name: str | None = None
    actor_email: str | None = None
    actor_role: str | None = None
    site_name: str | None = None
    #: For patient events: the patient's NCID (the hospital's dashboard looks the name up live).
    target_ncid: str | None = None


def _named(people, details: dict | None) -> dict | None:
    """Doctor IDs in an event become names for the log ("Reassigned: Dr. Rao → Dr. Iyer")."""
    if not details:
        return details
    out = dict(details)
    if isinstance(details.get("doctor"), str):
        out["doctor_name"] = people.staff_name(details["doctor"]) or "—"
    if "previous" in details:
        out["previous_name"] = people.staff_name(details["previous"]) if details["previous"] else "—"
    return out


def audit_rows(db: DbSession, site_id: str | None, limit: int, platform_only: bool = False) -> list[AuditOut]:
    q = select(AuditEvent).order_by(AuditEvent.at.desc()).limit(limit)
    if site_id is not None:
        q = q.where(AuditEvent.site_id == site_id)
    elif platform_only:
        q = q.where(AuditEvent.site_id.is_(None))
    from app.models import Patient
    from app.people import People

    people = People(db)
    out = []
    for e in db.scalars(q):
        who = people.who(e.actor_type, e.actor_id)
        pt = db.get(Patient, e.target_id) if e.target_type == "patient" and e.target_id else None
        out.append(
            AuditOut(
                at=e.at,
                site_id=e.site_id,
                actor_type=e.actor_type,
                actor_id=e.actor_id,
                action=e.action,
                target_type=e.target_type,
                target_id=e.target_id,
                details=_named(people, e.details),
                actor_name=who.name,
                actor_email=who.email,
                actor_role=who.role,
                site_name=people.site_name(e.site_id),
                target_ncid=pt.ncid if pt else None,
            )
        )
    return out


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
    #: Decision 044: the hospital's own storage passed its test (phones may record).
    can_record: bool
    take_key: bool
    devices: int
    operators: int
    doctors: int


@router.get("/hospitals/{site_id}/connector-history", response_model=ConnectorHistoryOut)
def hospital_connector_history(
    site_id: str,
    _: Principal = Depends(admin_only),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> ConnectorHistoryOut:
    """v29 (decision 052): one hospital's connector check-ins (counts per hour only)."""
    return history(db, _site(db, site_id))


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
        can_record=can_record(site),
        take_key=db.scalar(select(SiteKey).where(SiteKey.site_id == site.id, SiteKey.status == "active"))
        is not None,
        devices=out.devices,
        operators=out.operators,
        doctors=sum(1 for u in staff if u.role == "doctor" and u.active),
    )


# --- Roles and permissions per hospital (decision 033) ---


class PermissionRow(BaseModel):
    key: str
    group: str
    default: list[str]
    eligible: list[str]
    roles: list[str]
    changed: bool


class PermissionsOut(BaseModel):
    site_id: str
    rows: list[PermissionRow]
    changed_at: datetime | None
    changed_by_name: str | None
    changed_by_email: str | None
    reason: str | None


class PermissionsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: {permission: roles}; permissions left out keep the default.
    roles: dict[str, list[str]]
    reason: str = Field(min_length=3, max_length=300)


def permissions_out(db: DbSession, site: Site) -> PermissionsOut:
    from app.people import People
    from app.permissions import catalogue, effective

    eff = effective(site)
    rows = [
        PermissionRow(
            key=k,
            group=spec["group"],
            default=list(spec["default"]),
            eligible=list(spec["eligible"]),
            roles=eff[k],
            changed=sorted(eff[k]) != sorted(r for r in spec["default"] if r in spec["eligible"]),
        )
        for k, spec in catalogue().items()
    ]
    last = db.scalar(
        select(AuditEvent)
        .where(AuditEvent.site_id == site.id, AuditEvent.action == "permissions_changed")
        .order_by(AuditEvent.at.desc())
        .limit(1)
    )
    who = People(db).who(last.actor_type, last.actor_id) if last else None
    return PermissionsOut(
        site_id=site.id,
        rows=rows,
        changed_at=last.at if last else None,
        changed_by_name=who.name if who else None,
        changed_by_email=who.email if who else None,
        reason=(last.details or {}).get("reason") if last else None,
    )


def _site_or_404(db: DbSession, site_id: str) -> Site:
    site = db.get(Site, site_id)
    if not site:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "hospital not found")
    return site


@router.get("/hospitals/{site_id}/permissions", response_model=PermissionsOut)
def get_permissions(
    site_id: str, _: Principal = Depends(admin_only), db: DbSession = Depends(get_db)
) -> PermissionsOut:  # noqa: B008
    return permissions_out(db, _site_or_404(db, site_id))


@router.put("/hospitals/{site_id}/permissions", response_model=PermissionsOut)
def set_permissions(
    site_id: str,
    body: PermissionsIn,
    p: Principal = Depends(admin_only),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> PermissionsOut:
    """Only what differs from the defaults is stored; an empty map is "reset to defaults"."""
    from app.permissions import ROLES, catalogue

    site = _site_or_404(db, site_id)
    cat = catalogue()
    over: dict[str, list[str]] = {}
    for key, roles in body.roles.items():
        spec = cat.get(key)
        if spec is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "unknown_permission", "key": key}
            )
        bad = [r for r in roles if r not in spec["eligible"]]
        if bad:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "role_not_eligible", "key": key, "roles": bad}
            )
        clean = [r for r in ROLES if r in roles]
        if sorted(clean) != sorted(r for r in spec["default"] if r in spec["eligible"]):
            over[key] = clean
    before = site.permissions or {}
    site.permissions = over or None
    changed = sorted(set(before) | set(over))
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "permissions_changed",
        "site",
        site.id,
        site_id=site.id,
        reason=body.reason.strip(),
        changed=[k for k in changed if before.get(k) != over.get(k)],
    )
    db.commit()
    return permissions_out(db, site)


class PlatformSettingsOut(BaseModel):
    """Decision 044: what this platform offers hospitals for video storage (it stores none)."""

    storage_offered: list[str]
    azure_app_registered: bool
    azure_app_client_id: str | None
    dev_storage: bool


@router.get("/settings", response_model=PlatformSettingsOut)
def platform_settings(_: Principal = Depends(admin_only)) -> PlatformSettingsOut:  # noqa: B008
    from app.api.hospital_storage import storage_offered

    s = get_settings()
    return PlatformSettingsOut(
        storage_offered=storage_offered(),
        azure_app_registered=bool(s.azure_client_id),
        azure_app_client_id=s.azure_client_id,
        dev_storage=s.dev_storage,
    )
