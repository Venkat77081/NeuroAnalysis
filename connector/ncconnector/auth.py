"""Who may call the connector.

- Browser (doctor, hospital admin): a short-lived EdDSA token from the platform
  (POST /hospital/connector-token), audience "site:<this site>".
- Platform: an Ed25519-signed request (X-NC-Key "platform").
"""

from dataclasses import dataclass

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from ncconnector.config import get_settings
from ncconnector.keys import platform_public_key
from ncconnector.signing import NONCES, verify_signed

bearer = HTTPBearer(auto_error=False)


@dataclass
class Staff:
    user_id: str
    role: str  # hospital_admin | doctor


def staff(creds: HTTPAuthorizationCredentials | None = Depends(bearer)) -> Staff:
    if not creds:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing token")
    try:
        claims = jwt.decode(
            creds.credentials,
            platform_public_key(),
            algorithms=["EdDSA"],
            audience=f"site:{get_settings().site_id}",
            issuer="neurocapture",
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid token") from exc
    if claims.get("typ") != "connector" or claims.get("role") not in {"hospital_admin", "doctor"}:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid token")
    return Staff(user_id=str(claims["sub"]), role=claims["role"])


def role(*roles: str):
    def check(s: Staff = Depends(staff)) -> Staff:
        if s.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "role not allowed")
        return s

    return check


async def platform_signed(request: Request) -> None:
    path = request.url.path + (f"?{request.url.query}" if request.url.query else "")
    body = await request.body()
    ok = request.headers.get("x-nc-key") == "platform" and verify_signed(
        platform_public_key(),
        request.method,
        path,
        request.headers,
        body,
        get_settings().signature_window_s,
        NONCES,
    )
    if not ok:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad platform signature")
