"""Per-hospital permissions (decision 033). The defaults and which roles each permission may be
given to are in config/platform.json (`permissions`); a platform admin can change them for one
hospital. Fixed rules are not permissions and live in code: clinical data only for the assigned
doctor (app.assignments), no patient identity on the platform, consent before recording, and
every action logged."""

from fastapi import Depends, HTTPException, status
from sqlalchemy.orm import Session as DbSession

from app.db import get_db
from app.models import Site
from app.policy import policy
from app.security import Principal, current_principal

ROLES = ("hospital_admin", "receptionist", "doctor", "operator")


def catalogue() -> dict[str, dict]:
    return policy()["permissions"]


def effective(site: Site | None) -> dict[str, list[str]]:
    """{permission: roles} for this hospital (its overrides on top of the defaults)."""
    over = (site.permissions or {}) if site else {}
    out = {}
    for key, spec in catalogue().items():
        roles = over.get(key, spec["default"])
        out[key] = [r for r in ROLES if r in roles and r in spec["eligible"]]
    return out


def role_of(p: Principal) -> str:
    return "operator" if p.kind == "operator" else p.role


def granted(db: DbSession, p: Principal) -> list[str]:
    """The permissions this signed-in person has at their hospital."""
    site = db.get(Site, p.site_id) if p.site_id else None
    role = role_of(p)
    return [k for k, roles in effective(site).items() if role in roles]


def allows(db: DbSession, p: Principal, key: str) -> bool:
    site = db.get(Site, p.site_id) if p.site_id else None
    return role_of(p) in effective(site).get(key, [])


def require(*keys: str):
    """FastAPI dependency: the person needs at least one of these permissions at their hospital."""

    def check(p: Principal = Depends(current_principal), db: DbSession = Depends(get_db)) -> Principal:  # noqa: B008
        if p.kind == "staff" and not p.mfa:
            raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "two_step_required"})
        if p.kind not in ("staff", "operator") or not any(allows(db, p, k) for k in keys):
            raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "not_permitted"})
        return p

    return check
