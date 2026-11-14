"""Admin bootstrap: create a site (with its enrollment code) and operators.

python -m app.admin create-site --name "Clinic A" --region IN --enrollment-code XXXX
python -m app.admin create-operator --site <id> --code OP-07 --pin 1234 --role operator
"""

import argparse
import secrets

from sqlalchemy.orm import Session as DbSession

from app.db import _factory
from app.models import Operator, Site
from app.security import hash_pin, sha256_hex


def create_site(db: DbSession, name: str, region: str, enrollment_code: str) -> Site:
    site = Site(
        name=name,
        region=region,
        enrollment_code_hash=sha256_hex(enrollment_code),
        patient_ref_salt=secrets.token_hex(16),
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
    a = ap.parse_args(argv)
    with _factory()() as db:
        if a.cmd == "create-site":
            print(create_site(db, a.name, a.region, a.enrollment_code).id)  # noqa: T201
        else:
            print(create_operator(db, a.site, a.code, a.pin, a.role).id)  # noqa: T201


if __name__ == "__main__":
    main()
