"""Secrets, passwords, two-step codes and tokens (DEV_PLAN §13.2, §14; PLATFORM_PLAN M10).

No plaintext secret is stored. Three kinds of signed-in principal share one type:
- operator: a clinic operator on a hospital-registered phone (token typ "device")
- patient: a patient on their own phone (typ "patient"), known only by NCID
- staff: a web dashboard user (typ "staff"): platform admin, hospital admin or doctor
"""

import base64
import hashlib
import hmac
import secrets
import struct
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.db import get_db
from app.models import Device, Operator, Patient, PatientAccount, Site, StaffUser

PBKDF2_ITERATIONS = 200_000


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def new_secret(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def hash_pin(pin: str, salt: bytes | None = None) -> str:
    """PBKDF2-SHA256 for PINs and passwords (same format)."""
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pin.encode(), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2${PBKDF2_ITERATIONS}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_pin(pin: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        _, iters, salt_b64, dk_b64 = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", pin.encode(), base64.b64decode(salt_b64), int(iters))
        return hmac.compare_digest(dk, base64.b64decode(dk_b64))
    except ValueError:
        return False


hash_password = hash_pin
verify_password = verify_pin


def password_ok(pw: str) -> bool:
    """At least `passwords.minLength` characters (config/platform.json), a letter and a digit."""
    from app.policy import policy

    min_len = policy()["passwords"]["minLength"]
    return len(pw) >= min_len and any(c.isalpha() for c in pw) and any(c.isdigit() for c in pw)


def temporary_password() -> str:
    """Readable one-time password (no 0/O/1/l), always with letters and digits."""
    from app.policy import policy

    n = policy()["passwords"]["temporaryLength"]
    letters, digits = "abcdefghjkmnpqrstuvwxyz", "23456789"
    body = [secrets.choice(letters + digits) for _ in range(n - 2)]
    return "".join(body) + secrets.choice(letters) + secrets.choice(digits)


# --- Two-step sign-in (TOTP, RFC 6238: 30 s, 6 digits, SHA-1 as authenticator apps expect) ---


def new_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def totp_code(secret: str, at: float | None = None, step: int = 30) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    counter = int((time.time() if at is None else at) // step)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    off = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[off : off + 4])[0] & 0x7FFFFFFF
    return f"{value % 1_000_000:06d}"


def totp_verify(secret: str, code: str, at: float | None = None) -> bool:
    """Accepts the current code and one step either side (clock drift)."""
    t = time.time() if at is None else at
    return any(hmac.compare_digest(totp_code(secret, t + d * 30), code.strip()) for d in (-1, 0, 1))


def totp_uri(secret: str, account: str) -> str:
    return f"otpauth://totp/NeuroCapture:{quote(account)}?secret={secret}&issuer=NeuroCapture"


# --- Tokens ---


def _encode(claims: dict, ttl_s: int) -> tuple[str, int]:
    s = get_settings()
    claims = {**claims, "exp": datetime.now(UTC) + timedelta(seconds=ttl_s)}
    return jwt.encode(claims, s.jwt_secret, algorithm="HS256"), ttl_s


def create_access_token(operator: Operator, device: Device) -> tuple[str, int]:
    return _encode(
        {
            "typ": "device",
            "sub": operator.id,
            "dev": device.id,
            "site": operator.site_id,
            "role": operator.role,
        },
        get_settings().access_ttl_s,
    )


def create_patient_token(account: PatientAccount, device: Device) -> tuple[str, int]:
    return _encode(
        {"typ": "patient", "sub": account.id, "dev": device.id, "site": account.site_id, "role": "patient"},
        get_settings().access_ttl_s,
    )


def create_staff_token(user: StaffUser, mfa: bool) -> tuple[str, int]:
    """`mfa` = signed in with the two-step code. Without it, only two-step set-up is allowed."""
    return _encode(
        {"typ": "staff", "sub": user.id, "site": user.site_id, "role": user.role, "mfa": mfa},
        get_settings().access_ttl_s,
    )


def create_challenge_token(user: StaffUser) -> str:
    """Short-lived proof that the password was right; the two-step code completes sign-in."""
    token, _ = _encode({"typ": "challenge", "sub": user.id}, 300)
    return token


def decode(token: str, typ: str) -> dict:
    try:
        claims = jwt.decode(token, get_settings().jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid token") from exc
    if claims.get("typ", "device") != typ:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong token type")
    return claims


@dataclass
class Principal:
    """Who is calling. `site_id` is None only for platform admins."""

    kind: str  # operator | patient | staff
    role: str
    site_id: str | None
    actor_id: str
    operator: Operator | None = None
    device: Device | None = None
    patient: PatientAccount | None = None
    user: StaffUser | None = None
    #: Staff only: the sign-in included the two-step code.
    mfa: bool = True

    @property
    def actor_type(self) -> str:
        return {"operator": "operator", "patient": "patient", "staff": self.role}[self.kind]


bearer = HTTPBearer(auto_error=False)


def current_principal(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> Principal:
    if not creds:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing token")
    try:
        claims = jwt.decode(creds.credentials, get_settings().jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid token") from exc
    typ = claims.get("typ", "device")
    denied = HTTPException(status.HTTP_401_UNAUTHORIZED, "account or device not allowed")
    site_id = claims.get("site")
    if site_id is not None:
        site = db.get(Site, site_id)
        if not site or site.status == "suspended":
            raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "hospital_suspended"})
    if typ == "staff":
        user = db.get(StaffUser, claims.get("sub"))
        if not user or not user.active:
            raise denied
        return Principal("staff", user.role, user.site_id, user.id, user=user, mfa=bool(claims.get("mfa")))
    dev = db.get(Device, claims.get("dev"))
    if not dev or dev.revoked_at is not None:
        raise denied
    if typ == "patient":
        acc = db.get(PatientAccount, claims.get("sub"))
        if not acc or acc.status != "active" or acc.device_id != dev.id:
            raise denied
        return Principal("patient", "patient", acc.site_id, acc.id, device=dev, patient=acc)
    if typ != "device":
        raise denied
    op = db.get(Operator, claims.get("sub"))
    if not op or not op.active:
        raise denied
    return Principal("operator", op.role, op.site_id, op.id, operator=op, device=dev)


def require_role(*roles: str):
    def check(p: Principal = Depends(current_principal)) -> Principal:  # noqa: B008
        if p.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "role not allowed")
        if p.kind == "staff" and not p.mfa:
            raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "two_step_required"})
        return p

    return check


def require_device(p: Principal = Depends(current_principal)) -> Principal:  # noqa: B008
    """Endpoints a phone calls (sessions, takes, uploads): operators and patients only."""
    if p.device is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "phone sign-in required")
    if p.operator is not None and p.operator.must_change_password:
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "password_change_required"})
    return p


def patient_of(db: DbSession, p: Principal) -> Patient | None:
    return db.get(Patient, p.patient.patient_id) if p.patient else None
