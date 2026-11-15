"""Web dashboard sign-in (PLATFORM_PLAN M10): invite link -> password -> two-step code.

Platform admins, hospital admins and doctors. A token without the two-step code (`mfa` false)
only allows setting up two-step sign-in; every role-checked endpoint refuses it.
"""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.audit import audit
from app.config import get_settings
from app.db import get_db
from app.models import Site, StaffRefreshToken, StaffUser
from app.policy import policy
from app.security import (
    Principal,
    create_challenge_token,
    create_staff_token,
    current_principal,
    decode,
    hash_password,
    new_secret,
    new_totp_secret,
    password_ok,
    sha256_hex,
    totp_uri,
    totp_verify,
    verify_password,
)

router = APIRouter(prefix="/staff", tags=["staff"])


def aware(dt: datetime | None) -> datetime | None:
    return dt if dt is None or dt.tzinfo else dt.replace(tzinfo=UTC)


def new_staff_invite(user: StaffUser) -> str:
    """Sets a fresh single-use invite on `user`; returns the link for the e-mail."""
    token = new_secret()
    user.invite_token_hash = sha256_hex(token)
    user.invite_expires_at = datetime.now(UTC) + timedelta(days=policy()["invites"]["staffTtlDays"])
    return f"{get_settings().dashboard_url}/invite?t={token}"


class AcceptIn(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    password: str = Field(min_length=1, max_length=128)


@router.post("/invite/accept", status_code=204)
def accept_invite(body: AcceptIn, db: DbSession = Depends(get_db)) -> None:  # noqa: B008
    user = db.scalar(select(StaffUser).where(StaffUser.invite_token_hash == sha256_hex(body.token)))
    exp = aware(user.invite_expires_at) if user else None
    if not user or not user.active or exp is None or exp < datetime.now(UTC):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "invite link used or expired")
    if not password_ok(body.password):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "weak_password"})
    user.password_hash = hash_password(body.password)
    user.invite_token_hash = None
    user.invite_expires_at = None
    if user.site_id and user.role == "hospital_admin":
        site = db.get(Site, user.site_id)
        if site and site.status == "invited":
            site.status = "active"
            audit(db, user.role, user.id, "hospital_activated", "site", site.id, site_id=site.id)
    audit(db, user.role, user.id, "invite_accepted", "staff", user.id, site_id=user.site_id)
    db.commit()


class LoginIn(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=128)


class StaffTokens(BaseModel):
    access_token: str
    refresh_token: str | None = None
    expires_in: int
    role: str
    site_id: str | None
    #: True: the token only allows two-step set-up (POST /staff/two-step/setup, /confirm).
    two_step_setup_required: bool = False


class LoginOut(BaseModel):
    #: Password was right; send the two-step code with this to /staff/login/two-step.
    challenge_token: str | None = None
    tokens: StaffTokens | None = None


def _issue(db: DbSession, user: StaffUser, mfa: bool) -> StaffTokens:
    access, ttl = create_staff_token(user, mfa)
    refresh = None
    if mfa:
        refresh = new_secret()
        db.add(
            StaffRefreshToken(
                user_id=user.id,
                token_hash=sha256_hex(refresh),
                expires_at=datetime.now(UTC) + timedelta(seconds=get_settings().refresh_ttl_s),
            )
        )
        user.last_login_at = datetime.now(UTC)
        user.failed_logins = 0
    return StaffTokens(
        access_token=access,
        refresh_token=refresh,
        expires_in=ttl,
        role=user.role,
        site_id=user.site_id,
        two_step_setup_required=not mfa,
    )


def _site_allows(db: DbSession, user: StaffUser) -> bool:
    if user.site_id is None:
        return True
    site = db.get(Site, user.site_id)
    return bool(site and site.status != "suspended")


def locked(user: StaffUser) -> bool:
    return user.failed_logins >= policy()["staff"]["maxFailedLogins"]


def _failed(db: DbSession, user: StaffUser, action: str) -> None:
    user.failed_logins += 1
    audit(db, user.role, user.id, action, site_id=user.site_id, attempt=user.failed_logins)
    if locked(user):
        audit(db, "system", None, "staff_locked", "staff", user.id, site_id=user.site_id)
    db.commit()


@router.post("/login", response_model=LoginOut)
def login(body: LoginIn, db: DbSession = Depends(get_db)) -> LoginOut:  # noqa: B008
    user = db.scalar(select(StaffUser).where(StaffUser.email == body.email.strip().lower()))
    if user and locked(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "account_locked"})
    if not user or not user.active or not verify_password(body.password, user.password_hash):
        if user and user.active:
            _failed(db, user, "staff_login_failed")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong e-mail or password")
    if not _site_allows(db, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "hospital_suspended"})
    if user.totp_enabled:
        return LoginOut(challenge_token=create_challenge_token(user))
    if policy()["staff"]["twoStepRequired"]:
        # First sign-in: a set-up-only token. Two-step must be confirmed before any other call.
        return LoginOut(tokens=_issue(db, user, mfa=False))
    out = _issue(db, user, mfa=True)
    db.commit()
    return LoginOut(tokens=out)


class TwoStepIn(BaseModel):
    challenge_token: str
    code: str = Field(min_length=6, max_length=8)


@router.post("/login/two-step", response_model=StaffTokens)
def login_two_step(body: TwoStepIn, db: DbSession = Depends(get_db)) -> StaffTokens:  # noqa: B008
    claims = decode(body.challenge_token, "challenge")
    user = db.get(StaffUser, claims.get("sub"))
    if not user or not user.active or not user.totp_enabled or not user.totp_secret:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "sign in again")
    if locked(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "account_locked"})
    if not totp_verify(user.totp_secret, body.code):
        _failed(db, user, "staff_two_step_failed")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong code")
    if not _site_allows(db, user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "hospital_suspended"})
    out = _issue(db, user, mfa=True)
    audit(db, user.role, user.id, "staff_login", site_id=user.site_id)
    db.commit()
    return out


def staff(p: Principal = Depends(current_principal)) -> Principal:  # noqa: B008
    if p.kind != "staff" or p.user is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "dashboard sign-in required")
    return p


class SetupOut(BaseModel):
    secret: str
    otpauth_uri: str


@router.post("/two-step/setup", response_model=SetupOut)
def two_step_setup(p: Principal = Depends(staff), db: DbSession = Depends(get_db)) -> SetupOut:  # noqa: B008
    user = p.user
    assert user is not None
    if user.totp_enabled:
        raise HTTPException(status.HTTP_409_CONFLICT, "two-step sign-in is already on")
    user.totp_secret = new_totp_secret()
    db.commit()
    return SetupOut(secret=user.totp_secret, otpauth_uri=totp_uri(user.totp_secret, user.email))


class ConfirmIn(BaseModel):
    code: str = Field(min_length=6, max_length=8)


@router.post("/two-step/confirm", response_model=StaffTokens)
def two_step_confirm(
    body: ConfirmIn,
    p: Principal = Depends(staff),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> StaffTokens:
    user = p.user
    assert user is not None
    if user.totp_enabled or not user.totp_secret or not totp_verify(user.totp_secret, body.code):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "wrong code")
    user.totp_enabled = True
    out = _issue(db, user, mfa=True)
    audit(db, user.role, user.id, "two_step_enabled", "staff", user.id, site_id=user.site_id)
    db.commit()
    return out


class RefreshIn(BaseModel):
    refresh_token: str


@router.post("/refresh", response_model=StaffTokens)
def refresh(body: RefreshIn, db: DbSession = Depends(get_db)) -> StaffTokens:  # noqa: B008
    rt = db.scalar(
        select(StaffRefreshToken).where(StaffRefreshToken.token_hash == sha256_hex(body.refresh_token))
    )
    exp = aware(rt.expires_at) if rt else None
    if not rt or rt.revoked or exp is None or exp < datetime.now(UTC):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "refresh token invalid")
    user = db.get(StaffUser, rt.user_id)
    if not user or not user.active or not _site_allows(db, user):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "account not allowed")
    rt.revoked = True
    out = _issue(db, user, mfa=True)
    db.commit()
    return out


class MeOut(BaseModel):
    id: str
    role: str
    site_id: str | None
    site_name: str | None
    email: str
    display_name: str | None
    two_step_enabled: bool


@router.get("/me", response_model=MeOut)
def me(p: Principal = Depends(staff), db: DbSession = Depends(get_db)) -> MeOut:  # noqa: B008
    user = p.user
    assert user is not None
    site = db.get(Site, user.site_id) if user.site_id else None
    return MeOut(
        id=user.id,
        role=user.role,
        site_id=user.site_id,
        site_name=site.name if site else None,
        email=user.email,
        display_name=user.display_name,
        two_step_enabled=user.totp_enabled,
    )
