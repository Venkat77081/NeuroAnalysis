"""Device registration, operator login and token refresh (DEV_PLAN §13.2)."""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.audit import audit
from app.config import get_settings
from app.db import get_db
from app.keys import server_public_key
from app.models import Device, DeviceEnrollment, Operator, RefreshToken, Site
from app.security import (
    Principal,
    create_access_token,
    current_principal,
    hash_password,
    new_secret,
    password_ok,
    require_role,
    sha256_hex,
    verify_pin,
)

router = APIRouter(prefix="/auth", tags=["auth"])


class RegisterIn(BaseModel):
    enrollment_code: str = Field(min_length=6, max_length=100)
    model: str = Field(max_length=100)
    os_version: str = Field(max_length=50)


class ServerKey(BaseModel):
    key_id: str
    public_key_pem: str


class RegisterOut(BaseModel):
    device_id: str
    device_secret: str
    site_id: str
    patient_ref_salt: str
    server_key: ServerKey


@router.post("/device-register", response_model=RegisterOut, status_code=201)
def device_register(body: RegisterIn, db: DbSession = Depends(get_db)) -> RegisterOut:  # noqa: B008
    """A clinic phone joins its hospital with a one-time code from the dashboard (M10), or the
    hospital's standing enrollment code (pilot set-up)."""
    code_hash = sha256_hex(body.enrollment_code.strip().upper())
    enr = db.scalar(select(DeviceEnrollment).where(DeviceEnrollment.code_hash == code_hash))
    now_ = datetime.now(UTC)
    if enr:
        exp = enr.expires_at if enr.expires_at.tzinfo else enr.expires_at.replace(tzinfo=UTC)
        if enr.used_at is not None or exp < now_:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "registration code used or expired")
        site = db.get(Site, enr.site_id)
    else:
        site = db.scalar(select(Site).where(Site.enrollment_code_hash == sha256_hex(body.enrollment_code)))
    if not site or site.status == "suspended":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "unknown enrollment code")
    secret = new_secret()
    dev = Device(
        site_id=site.id,
        model=body.model,
        os_version=body.os_version,
        secret_hash=sha256_hex(secret),
        kind="clinic",
        label=enr.label if enr else None,
    )
    db.add(dev)
    db.flush()
    if enr:
        enr.used_at = now_
        enr.device_id = dev.id
    audit(db, "device", dev.id, "device_registered", "site", site.id, site_id=site.id, model=body.model)
    db.commit()
    key_id, pem = server_public_key()
    return RegisterOut(
        device_id=dev.id,
        device_secret=secret,
        site_id=site.id,
        patient_ref_salt=site.patient_ref_salt,
        server_key=ServerKey(key_id=key_id, public_key_pem=pem),
    )


class LoginIn(BaseModel):
    device_id: str
    device_secret: str
    #: Operator ID, e.g. OP-07.
    operator_code: str = Field(max_length=20)
    #: M10: the operator's password. `pin` is the pre-M10 field name (same check).
    password: str | None = Field(default=None, min_length=4, max_length=128)
    pin: str | None = Field(default=None, min_length=4, max_length=20)


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    expires_in: int
    operator_id: str
    role: str
    must_change_password: bool = False


def _issue(db: DbSession, op: Operator, dev: Device) -> TokenOut:
    access, ttl = create_access_token(op, dev)
    refresh = new_secret()
    db.add(
        RefreshToken(
            operator_id=op.id,
            device_id=dev.id,
            token_hash=sha256_hex(refresh),
            expires_at=datetime.now(UTC) + timedelta(seconds=get_settings().refresh_ttl_s),
        )
    )
    return TokenOut(
        access_token=access,
        refresh_token=refresh,
        expires_in=ttl,
        operator_id=op.id,
        role=op.role,
        must_change_password=op.must_change_password,
    )


def _device(db: DbSession, device_id: str, secret: str) -> Device:
    dev = db.get(Device, device_id)
    if not dev or dev.revoked_at is not None or dev.secret_hash != sha256_hex(secret) or dev.kind != "clinic":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "device not registered or revoked")
    return dev


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, db: DbSession = Depends(get_db)) -> TokenOut:  # noqa: B008
    dev = _device(db, body.device_id, body.device_secret)
    op = db.scalar(
        select(Operator).where(Operator.site_id == dev.site_id, Operator.code == body.operator_code)
    )
    secret = body.password or body.pin or ""
    if not op or not op.active or not verify_pin(secret, op.pin_hash):
        audit(db, "device", dev.id, "login_failed", site_id=dev.site_id)
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong operator ID or password")
    out = _issue(db, op, dev)
    audit(db, "operator", op.id, "login", "device", dev.id, site_id=dev.site_id)
    db.commit()
    return out


class PasswordIn(BaseModel):
    current_password: str = Field(max_length=128)
    new_password: str = Field(max_length=128)


@router.post("/change-password", status_code=204)
def change_password(
    body: PasswordIn,
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> None:
    """Operator on a clinic phone. Required after a hospital admin creates or resets the account."""
    op = p.operator
    if op is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "operator sign-in required")
    if not verify_pin(body.current_password, op.pin_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong password")
    if not password_ok(body.new_password) or body.new_password == body.current_password:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "weak_password"})
    op.pin_hash = hash_password(body.new_password)
    op.must_change_password = False
    audit(db, "operator", op.id, "operator_password_changed", site_id=op.site_id)
    db.commit()


class RefreshIn(BaseModel):
    refresh_token: str


@router.post("/refresh", response_model=TokenOut)
def refresh(body: RefreshIn, db: DbSession = Depends(get_db)) -> TokenOut:  # noqa: B008
    rt = db.scalar(select(RefreshToken).where(RefreshToken.token_hash == sha256_hex(body.refresh_token)))
    expires = rt.expires_at if rt else None
    if expires is not None and expires.tzinfo is None:
        expires = expires.replace(tzinfo=UTC)
    if not rt or rt.revoked or expires is None or expires < datetime.now(UTC):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "refresh token invalid")
    op = db.get(Operator, rt.operator_id)
    dev = db.get(Device, rt.device_id)
    if not op or not op.active or not dev or dev.revoked_at is not None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "operator or device not allowed")
    rt.revoked = True  # rotation: each refresh token works once
    out = _issue(db, op, dev)
    db.commit()
    return out


@router.post("/devices/{device_id}/revoke", status_code=204)
def revoke_device(
    device_id: str,
    p: Principal = Depends(require_role("admin", "hospital_admin")),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> None:
    """Lost device (§14): refuse its tokens; local data stays encrypted with a non-exportable key."""
    dev = db.get(Device, device_id)
    if not dev or dev.site_id != p.site_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "device not found")
    dev.revoked_at = datetime.now(UTC)
    for rt in db.scalars(select(RefreshToken).where(RefreshToken.device_id == device_id)):
        rt.revoked = True
    audit(db, p.actor_type, p.actor_id, "device_revoked", "device", device_id, site_id=p.site_id)
    db.commit()
