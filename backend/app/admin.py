"""Admin bootstrap: create a site (with its enrollment code) and operators.

python -m app.admin create-site --name "Clinic A" --region IN --enrollment-code XXXX
python -m app.admin create-operator --site <id> --code OP-07 --pin 1234 --role operator
python -m app.admin create-platform-admin --email admin@example.org --name "Name"
    (M10) prints a one-time invite link for setting a password; two-step sign-in follows.
"""

import argparse
import secrets

from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.db import _factory
from app.models import Operator, Site, StaffUser
from app.security import hash_pin, sha256_hex


def create_site(db: DbSession, name: str, region: str, enrollment_code: str) -> Site:
    site = Site(
        name=name,
        region=region,
        enrollment_code_hash=sha256_hex(enrollment_code),
        patient_ref_salt=secrets.token_hex(16),
        # Decision 044: hospitals connect their own storage; test servers use development storage.
        storage_kind="dev" if get_settings().dev_storage else "none",
    )
    db.add(site)
    db.commit()
    return site


def create_operator(db: DbSession, site_id: str, code: str, pin: str, role: str = "operator") -> Operator:
    if role not in {"operator", "reviewer", "admin"}:
        raise ValueError("role must be operator, reviewer or admin")
    op = Operator(site_id=site_id, code=code, pin_hash=hash_pin(pin), role=role, active=True)
    db.add(op)
    db.commit()
    return op


def create_platform_admin(db: DbSession, email: str, name: str | None = None) -> tuple[StaffUser, str]:
    """Returns the user and their one-time invite link (shown only on this console)."""
    from app.api.staff import new_staff_invite

    user = StaffUser(site_id=None, role="platform_admin", email=email.strip().lower(), display_name=name)
    db.add(user)
    db.flush()
    link = new_staff_invite(user)
    db.commit()
    return user, link


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m app.admin")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("create-site")
    s.add_argument("--name", required=True)
    s.add_argument("--region", required=True)
    s.add_argument("--enrollment-code", required=True)
    o = sub.add_parser("create-operator")
    o.add_argument("--site", required=True)
    o.add_argument("--code", required=True)
    o.add_argument("--pin", required=True)
    o.add_argument("--role", default="operator")
    rs = sub.add_parser("reset-sign-in", help="new password and authenticator link for a staff member")
    rs.add_argument("--email", required=True)
    rs.add_argument("--reason", default="forgot_password")
    pa = sub.add_parser("create-platform-admin")
    pa.add_argument("--email", required=True)
    pa.add_argument("--name")
    a = ap.parse_args(argv)
    with _factory()() as db:
        if a.cmd == "reset-sign-in":
            from sqlalchemy import select

            from app.api.staff import reset_sign_in
            from app.models import StaffUser

            user = db.scalar(select(StaffUser).where(StaffUser.email == a.email.strip().lower()))
            if user is None:
                raise SystemExit("no staff member with that e-mail")
            out = reset_sign_in(db, user, "system", None, "the NeuroCapture server administrator", a.reason)
            # The link is printed here too: whoever runs this command already controls the server.
            print("e-mail sent" if out.sent else "e-mail NOT sent; hand over this link:")  # noqa: T201
            print(out.link or "(link only in the e-mail)")  # noqa: T201
            return
        if a.cmd == "create-platform-admin":
            _, link = create_platform_admin(db, a.email, a.name)
            print(link)  # noqa: T201
        elif a.cmd == "create-site":
            print(create_site(db, a.name, a.region, a.enrollment_code).id)  # noqa: T201
        else:
            print(create_operator(db, a.site, a.code, a.pin, a.role).id)  # noqa: T201


if __name__ == "__main__":
    main()
