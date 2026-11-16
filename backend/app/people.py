"""Who did it: the name, e-mail and role behind an audit row (user, 16 Nov 2026: every activity
log shows the person, not only the role). Staff and operators are NeuroCapture accounts, so their
names are kept here; patients are never named (they stay an NCID)."""

from dataclasses import dataclass

from sqlalchemy.orm import Session as DbSession

from app.models import Device, Operator, Site, StaffUser

STAFF_ROLES = {"platform_admin", "hospital_admin", "receptionist", "doctor"}


@dataclass(frozen=True)
class Who:
    name: str
    email: str | None
    role: str


class People:
    """Looks up actors once per request (logs repeat the same few people)."""

    def __init__(self, db: DbSession) -> None:
        self.db = db
        self._cache: dict[tuple[str, str | None], Who] = {}
        self._sites: dict[str, str | None] = {}

    def who(self, actor_type: str, actor_id: str | None) -> Who:
        key = (actor_type, actor_id)
        if key not in self._cache:
            self._cache[key] = self._lookup(actor_type, actor_id)
        return self._cache[key]

    def staff_name(self, user_id: str | None) -> str | None:
        u = self.db.get(StaffUser, user_id) if user_id else None
        return (u.display_name or u.email) if u else None

    def site_name(self, site_id: str | None) -> str | None:
        if site_id is None:
            return None
        if site_id not in self._sites:
            s = self.db.get(Site, site_id)
            self._sites[site_id] = s.name if s else None
        return self._sites[site_id]

    def _lookup(self, actor_type: str, actor_id: str | None) -> Who:
        if actor_type in STAFF_ROLES or actor_type == "staff":
            u = self.db.get(StaffUser, actor_id) if actor_id else None
            if u:
                return Who(u.display_name or u.email, u.email, u.role)
            return Who("Former staff member", None, actor_type)
        if actor_type == "operator":
            op = self.db.get(Operator, actor_id) if actor_id else None
            if op:
                return Who(f"{op.name} ({op.code})" if op.name else op.code, None, "operator")
            return Who("Operator", None, "operator")
        if actor_type == "device":
            d = self.db.get(Device, actor_id) if actor_id else None
            return Who(f"Clinic phone · {d.label}" if d and d.label else "Clinic phone", None, "device")
        if actor_type == "patient":
            return Who("Patient (app)", None, "patient")
        if actor_type == "connector":
            return Who("Hospital connector", None, "connector")
        return Who("NeuroCapture", None, "system")
