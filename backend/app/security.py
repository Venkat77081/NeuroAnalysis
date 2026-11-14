"""Secrets, PINs and tokens (DEV_PLAN §13.2, §14). No plaintext secret is stored."""

import base64
import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.db import get_db
from app.models import Device, Operator

PBKDF2_ITERATIONS = 200_000


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def new_secret(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def hash_pin(pin: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pin.encode(), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2${PBKDF2_ITERATIONS}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_pin(pin: str, stored: str) -> bool:
    try:
        _, iters, salt_b64, dk_b64 = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", pin.encode(), base64.b64decode(salt_b64), int(iters))
        return hmac.compare_digest(dk, base64.b64decode(dk_b64))
    except ValueError:
        return False


def create_access_token(operator: Operator, device: Device) -> tuple[str, int]:
    s = get_settings()
    exp = datetime.now(UTC) + timedelta(seconds=s.access_ttl_s)
    claims = {
        "sub": operator.id,
        "dev": device.id,
        "site": operator.site_id,
        "role": operator.role,
        "exp": exp,
    }
    return jwt.encode(claims, s.jwt_secret, algorithm="HS256"), s.access_ttl_s


@dataclass
class Principal:
    operator: Operator
    device: Device

    @property
    def role(self) -> str:
        return self.operator.role


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
    op = db.get(Operator, claims.get("sub"))
    dev = db.get(Device, claims.get("dev"))
    if not op or not op.active or not dev or dev.revoked_at is not None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "operator or device not allowed")
    return Principal(operator=op, device=dev)


def require_role(*roles: str):
    def check(p: Principal = Depends(current_principal)) -> Principal:  # noqa: B008
        if p.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "role not allowed")
        return p

    return check
