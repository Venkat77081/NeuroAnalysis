"""v11 patient app account (decision 043): one e-mail + app PIN for every hospital on a phone.

What the platform keeps (and does not):
- the e-mail only as HMAC-SHA256(account pepper, address); codes are sent to the address the
  patient types each time, so the address is never stored;
- the app PIN as a slow hash, with an attempt counter and a pause;
- an encrypted backup of the phone's hospital list, sealed on the phone. Its key is locked twice:
  with the PIN plus a server share (released only after a correct PIN), and with the recovery
  code, which never reaches the platform. The platform cannot open either copy by itself;
- which phone is signed in (model, last used) so a new phone can take over ("move").

The account is never linked to a hospital here: no NCID, site or hospital name is stored with it.
"""

import base64
import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal

import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.audit import audit
from app.config import get_settings
from app.db import get_db
from app.models import AppAccount, AppAccountCode, AppAccountToken
from app.policy import policy
from app.security import _encode, hash_pin, new_secret, sha256_hex, verify_pin

router = APIRouter(prefix="/account", tags=["app account"])
bearer = HTTPBearer(auto_error=False)

Email = Field(min_length=3, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
B64 = Field(min_length=16, max_length=200_000, pattern=r"^[A-Za-z0-9+/=_-]+$")


def _cfg() -> dict:
    return policy()["appAccount"]


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(dt: datetime | None) -> datetime | None:
    return dt if dt is None or dt.tzinfo else dt.replace(tzinfo=UTC)


def _pepper() -> bytes:
    return get_settings().account_pepper.encode()


def email_fp(email: str) -> str:
    return hmac.new(_pepper(), email.strip().lower().encode(), hashlib.sha256).hexdigest()


def server_share(account_id: str) -> str:
    """The server half of the PIN key. Derived from the pepper (key vault), never stored."""
    return base64.b64encode(
        hmac.new(_pepper(), f"share:{account_id}".encode(), hashlib.sha256).digest()
    ).decode()


def _code_hash(fp: str, code: str) -> str:
    return sha256_hex(f"{fp}:{code}")


def _pin_ok(pin: str) -> bool:
    rule = policy()["patientPin"]
    return pin.isdigit() and rule["minDigits"] <= len(pin) <= rule["maxDigits"]


# ---------------------------------------------------------------- e-mail codes


class CodeIn(BaseModel):
    email: str = Email
    purpose: Literal["signup", "signin", "recover"]


@router.post("/code", status_code=202)
def send_code(body: CodeIn, db: DbSession = Depends(get_db)) -> dict:  # noqa: B008
    """Sends a 6-digit code to the address typed. The same answer whether or not an account exists."""
    from app.delivery import DeliveryError
    from app.providers import account_code

    fp = email_fp(body.email)
    since = _now() - timedelta(hours=1)
    recent = db.scalars(
        select(AppAccountCode).where(AppAccountCode.email_fp == fp, AppAccountCode.created_at >= since)
    ).all()
    if len(recent) >= _cfg()["codeMaxPerHour"]:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, {"code": "too_many_codes"})
    for old in recent:
        old.used = True  # only the newest code works
    code = f"{secrets.randbelow(1_000_000):06d}"
    minutes = _cfg()["codeTtlMinutes"]
    db.add(
        AppAccountCode(
            email_fp=fp, code_hash=_code_hash(fp, code), expires_at=_now() + timedelta(minutes=minutes)
        )
    )
    try:
        account_code(body.email.strip(), code, minutes)
    except DeliveryError as exc:
        db.rollback()
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, {"code": "email_not_sent"}) from exc
    db.commit()
    return {"sent": True, "minutes": minutes}


def _check_code(db: DbSession, fp: str, code: str) -> AppAccountCode:
    """The newest unused code for this e-mail; wrong tries count. Not used up until the step succeeds."""
    row = db.scalar(
        select(AppAccountCode)
        .where(AppAccountCode.email_fp == fp, AppAccountCode.used.is_(False))
        .order_by(AppAccountCode.created_at.desc())
    )
    bad = HTTPException(status.HTTP_401_UNAUTHORIZED, {"code": "code_invalid"})
    if not row or _aware(row.expires_at) < _now():
        raise bad
    if not hmac.compare_digest(row.code_hash, _code_hash(fp, code.strip())):
        row.attempts += 1
        if row.attempts >= _cfg()["codeMaxAttempts"]:
            row.used = True
        db.commit()
        raise bad
    return row


# ---------------------------------------------------------------- tokens


class AccountTokens(BaseModel):
    access_token: str
    refresh_token: str
    expires_in: int


def _issue(db: DbSession, acc: AppAccount, install_id: str, label: str) -> AccountTokens:
    access, ttl = _encode({"typ": "account", "sub": acc.id, "iid": install_id}, get_settings().access_ttl_s)
    refresh = new_secret()
    db.add(
        AppAccountToken(
            account_id=acc.id,
            token_hash=sha256_hex(refresh),
            install_id=install_id,
            device_label=label[:120],
            expires_at=_now() + timedelta(seconds=get_settings().refresh_ttl_s),
        )
    )
    return AccountTokens(access_token=access, refresh_token=refresh, expires_in=ttl)


def _revoke_all(db: DbSession, acc: AppAccount, reason: str, keep_install: str | None = None) -> None:
    for t in db.scalars(
        select(AppAccountToken).where(
            AppAccountToken.account_id == acc.id, AppAccountToken.revoked.is_(False)
        )
    ):
        if keep_install and t.install_id == keep_install:
            continue
        t.revoked, t.revoked_reason = True, reason


def account_from_token(token: str, db: DbSession) -> AppAccount:
    """An app-account access token (also used by /patient/invite/accept to join without a PIN)."""
    try:
        claims = jwt.decode(token, get_settings().jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid token") from exc
    if claims.get("typ") != "account":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong token type")
    acc = db.get(AppAccount, claims.get("sub"))
    live = db.scalar(
        select(AppAccountToken).where(
            AppAccountToken.account_id == claims.get("sub"),
            AppAccountToken.install_id == claims.get("iid"),
            AppAccountToken.revoked.is_(False),
        )
    )
    if not acc or not live:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, {"code": "signed_out"})
    return acc


def signed_in(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> AppAccount:
    if not creds:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing token")
    return account_from_token(creds.credentials, db)


def _check_pin(db: DbSession, acc: AppAccount, pin: str) -> None:
    """Server-counted PIN tries: after patientPin.maxFailures the account pauses (appAccount.pauseHours)."""
    until = _aware(acc.paused_until)
    if until and until > _now():
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "paused", "until": until.isoformat()})
    if verify_pin(pin, acc.pin_hash):
        acc.failed_pins = 0
        acc.paused_until = None
        return
    acc.failed_pins += 1
    left = policy()["patientPin"]["maxFailures"] - acc.failed_pins
    if left <= 0:
        acc.failed_pins = 0
        acc.paused_until = _now() + timedelta(hours=_cfg()["pauseHours"])
        audit(db, "app_account", acc.id, "app_account_paused")
        db.commit()
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, {"code": "paused", "until": acc.paused_until.isoformat()}
        )
    db.commit()
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, {"code": "wrong_pin", "left": left})


class Unlocked(BaseModel):
    tokens: AccountTokens
    #: The server half of the PIN key (base64) and the salt for the phone's half.
    share: str
    kdf_salt: str
    backup: str | None = None
    wrap_pin: str | None = None


def _unlocked(acc: AppAccount, tokens: AccountTokens, with_backup: bool) -> Unlocked:
    return Unlocked(
        tokens=tokens,
        share=server_share(acc.id),
        kdf_salt=acc.kdf_salt,
        backup=acc.backup if with_backup else None,
        wrap_pin=acc.wrap_pin if with_backup else None,
    )


# ---------------------------------------------------------------- sign up, sign in, unlock


class Phone(BaseModel):
    install_id: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    device_label: str = Field(min_length=1, max_length=120)


class SignUpIn(Phone):
    email: str = Email
    code: str = Field(min_length=6, max_length=6)
    pin: str = Field(min_length=1, max_length=12)
    kdf_salt: str = Field(min_length=16, max_length=64)
    #: base64 check value derived from the recovery code on the phone (not the code).
    recovery_check: str = Field(min_length=16, max_length=200)


@router.post("/signup", response_model=Unlocked, status_code=201)
def signup(body: SignUpIn, db: DbSession = Depends(get_db)) -> Unlocked:  # noqa: B008
    fp = email_fp(body.email)
    code = _check_code(db, fp, body.code)
    if db.scalar(select(AppAccount).where(AppAccount.email_fp == fp)):
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "account_exists"})
    if not _pin_ok(body.pin):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "pin_format"})
    acc = AppAccount(
        email_fp=fp,
        pin_hash=hash_pin(body.pin),
        kdf_salt=body.kdf_salt,
        recovery_check_hash=sha256_hex(body.recovery_check),
    )
    db.add(acc)
    db.flush()
    code.used = True
    tokens = _issue(db, acc, body.install_id, body.device_label)
    audit(db, "app_account", acc.id, "app_account_created")
    db.commit()
    return _unlocked(acc, tokens, with_backup=False)


class SignInIn(Phone):
    email: str = Email
    code: str = Field(min_length=6, max_length=6)
    pin: str = Field(min_length=1, max_length=12)
    #: True once the patient agreed to move the account from their other phone.
    move: bool = False


@router.post("/signin", response_model=Unlocked)
def signin(body: SignInIn, db: DbSession = Depends(get_db)) -> Unlocked:  # noqa: B008
    """Reinstall or new phone: e-mail code and PIN. Another active phone needs `move` (it is signed out)."""
    fp = email_fp(body.email)
    code = _check_code(db, fp, body.code)
    acc = db.scalar(select(AppAccount).where(AppAccount.email_fp == fp))
    if not acc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, {"code": "no_account"})
    _check_pin(db, acc, body.pin)
    other = db.scalar(
        select(AppAccountToken)
        .where(
            AppAccountToken.account_id == acc.id,
            AppAccountToken.revoked.is_(False),
            AppAccountToken.install_id != body.install_id,
            AppAccountToken.expires_at > _now(),
        )
        .order_by(AppAccountToken.last_used_at.desc())
    )
    if other and not body.move:
        db.commit()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "code": "other_phone",
                "device_label": other.device_label,
                "last_used_at": _aware(other.last_used_at).isoformat(),
            },
        )
    _revoke_all(db, acc, "moved" if other else "signed_out")
    code.used = True
    tokens = _issue(db, acc, body.install_id, body.device_label)
    audit(db, "app_account", acc.id, "app_account_moved" if other else "app_account_signed_in")
    db.commit()
    return _unlocked(acc, tokens, with_backup=True)


class UnlockIn(BaseModel):
    refresh_token: str = Field(min_length=10, max_length=200)
    pin: str = Field(min_length=1, max_length=12)


def _live_token(db: DbSession, refresh: str) -> tuple[AppAccountToken, AppAccount]:
    t = db.scalar(select(AppAccountToken).where(AppAccountToken.token_hash == sha256_hex(refresh)))
    if not t:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, {"code": "signed_out"})
    if t.revoked:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, {"code": t.revoked_reason or "signed_out"})
    if _aware(t.expires_at) < _now():
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, {"code": "signed_out"})
    acc = db.get(AppAccount, t.account_id)
    assert acc is not None
    return t, acc


@router.post("/unlock", response_model=Unlocked)
def unlock(body: UnlockIn, db: DbSession = Depends(get_db)) -> Unlocked:  # noqa: B008
    """Opening the app: the PIN is checked here, so every wrong try counts, even after a reinstall."""
    t, acc = _live_token(db, body.refresh_token)
    _check_pin(db, acc, body.pin)
    t.revoked, t.revoked_reason = True, "rotated"
    tokens = _issue(db, acc, t.install_id, t.device_label)
    db.commit()
    return _unlocked(acc, tokens, with_backup=False)


class RefreshIn(BaseModel):
    refresh_token: str = Field(min_length=10, max_length=200)


@router.post("/refresh", response_model=AccountTokens)
def refresh(body: RefreshIn, db: DbSession = Depends(get_db)) -> AccountTokens:  # noqa: B008
    t, acc = _live_token(db, body.refresh_token)
    t.revoked, t.revoked_reason = True, "rotated"
    tokens = _issue(db, acc, t.install_id, t.device_label)
    db.commit()
    return tokens


class BackupIn(BaseModel):
    backup: str = B64
    wrap_pin: str = B64
    wrap_recovery: str | None = Field(
        default=None, min_length=16, max_length=200_000, pattern=r"^[A-Za-z0-9+/=_-]+$"
    )
    recovery_check: str | None = Field(default=None, min_length=16, max_length=200)


@router.put("/backup", status_code=204)
def put_backup(body: BackupIn, acc: AppAccount = Depends(signed_in), db: DbSession = Depends(get_db)) -> None:  # noqa: B008
    """The phone's sealed hospital list, after joining or leaving a hospital or a new PIN. Opaque here."""
    if (body.wrap_recovery is None) != (body.recovery_check is None):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "recovery_pair"})
    acc.backup, acc.wrap_pin, acc.backup_at = body.backup, body.wrap_pin, _now()
    if body.wrap_recovery is not None:
        acc.wrap_recovery = body.wrap_recovery
    if body.recovery_check is not None:
        acc.recovery_check_hash = sha256_hex(body.recovery_check)
    db.commit()


class MeOut(BaseModel):
    device_label: str
    has_backup: bool
    created_at: datetime


@router.get("/me", response_model=MeOut)
def me(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> MeOut:
    acc = signed_in(creds, db)
    t = db.scalar(
        select(AppAccountToken)
        .where(AppAccountToken.account_id == acc.id, AppAccountToken.revoked.is_(False))
        .order_by(AppAccountToken.last_used_at.desc())
    )
    return MeOut(
        device_label=t.device_label if t else "", has_backup=acc.backup is not None, created_at=acc.created_at
    )


@router.post("/sign-out", status_code=204)
def sign_out(body: RefreshIn, db: DbSession = Depends(get_db)) -> None:  # noqa: B008
    t = db.scalar(select(AppAccountToken).where(AppAccountToken.token_hash == sha256_hex(body.refresh_token)))
    if t and not t.revoked:
        t.revoked, t.revoked_reason = True, "signed_out"
        db.commit()


# ---------------------------------------------------------------- forgot PIN


class RecoverIn(BaseModel):
    email: str = Email
    code: str = Field(min_length=6, max_length=6)


class RecoverOut(BaseModel):
    """What the phone needs to open the backup with the recovery code (it cannot be opened here)."""

    kdf_salt: str
    backup: str | None
    wrap_recovery: str | None


@router.post("/recover", response_model=RecoverOut)
def recover(body: RecoverIn, db: DbSession = Depends(get_db)) -> RecoverOut:  # noqa: B008
    fp = email_fp(body.email)
    _check_code(db, fp, body.code)
    acc = db.scalar(select(AppAccount).where(AppAccount.email_fp == fp))
    if not acc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, {"code": "no_account"})
    return RecoverOut(kdf_salt=acc.kdf_salt, backup=acc.backup, wrap_recovery=acc.wrap_recovery)


class ResetPinIn(Phone):
    email: str = Email
    code: str = Field(min_length=6, max_length=6)
    new_pin: str = Field(min_length=1, max_length=12)
    #: Proof of the recovery code (keeps the backup), or `forget_backup` (starts the hospital list again).
    recovery_check: str | None = Field(default=None, min_length=16, max_length=200)
    forget_backup: bool = False
    #: A fresh salt for the new PIN key.
    kdf_salt: str = Field(min_length=16, max_length=64)


@router.post("/reset-pin", response_model=Unlocked)
def reset_pin(body: ResetPinIn, db: DbSession = Depends(get_db)) -> Unlocked:  # noqa: B008
    """Forgot PIN: e-mail code plus the recovery code (or, as a last resort, forget the backup)."""
    fp = email_fp(body.email)
    code = _check_code(db, fp, body.code)
    acc = db.scalar(select(AppAccount).where(AppAccount.email_fp == fp))
    if not acc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, {"code": "no_account"})
    if not _pin_ok(body.new_pin):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "pin_format"})
    if body.forget_backup:
        acc.backup = acc.wrap_pin = acc.wrap_recovery = acc.recovery_check_hash = acc.backup_at = None
    elif (
        not body.recovery_check
        or not acc.recovery_check_hash
        or not hmac.compare_digest(acc.recovery_check_hash, sha256_hex(body.recovery_check))
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "recovery_invalid"})
    acc.pin_hash = hash_pin(body.new_pin)
    acc.kdf_salt = body.kdf_salt
    acc.failed_pins = 0
    acc.paused_until = None
    acc.wrap_pin = None if body.forget_backup else acc.wrap_pin  # the phone locks it again with the new PIN
    _revoke_all(db, acc, "pin_reset")
    code.used = True
    tokens = _issue(db, acc, body.install_id, body.device_label)
    audit(db, "app_account", acc.id, "app_account_pin_reset", forgot_backup=body.forget_backup)
    db.commit()
    return _unlocked(acc, tokens, with_backup=False)
