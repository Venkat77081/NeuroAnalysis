"""Seeds the platform database for the M14 e2e stack: a platform admin, one hospital with its
connector registered, a hospital admin and a doctor (two-step on), and a doctor without two-step
yet (first sign-in flow). Prints the details as one JSON line."""

import json
import os
from datetime import UTC, datetime

from app.db import _factory, get_engine
from app.models import Base, Site, StaffUser
from app.security import hash_password, new_totp_secret, sha256_hex

Base.metadata.create_all(get_engine())
pw = os.environ["E2E_PASSWORD"]
with _factory()() as db:
    root = StaffUser(
        site_id=None,
        role="platform_admin",
        email="root@neurocapture.example",
        password_hash=hash_password(pw),
        totp_secret=new_totp_secret(),
        totp_enabled=True,
        display_name="Platform admin",
    )
    db.add(root)
    db.flush()
    site = Site(
        name="Sunrise Neuro Clinic",
        region="IN",
        city="Chennai",
        kind="clinic",
        data_mode="byo",
        status="active",
        modules={"clinic": True, "home": True},
        enrollment_code_hash=sha256_hex(os.urandom(16).hex()),
        patient_ref_salt=os.urandom(16).hex(),
        onboarded_by=root.id,
        onboarded_at=datetime.now(UTC),
        connector_url=os.environ["E2E_CONNECTOR_URL"],
        connector_public_key=os.environ["E2E_CONNECTOR_PUBLIC"],
    )
    db.add(site)
    db.flush()
    admin = StaffUser(
        site_id=site.id,
        role="hospital_admin",
        email="admin@sunrise.example",
        password_hash=hash_password(pw),
        totp_secret=new_totp_secret(),
        totp_enabled=True,
        display_name="Hospital admin",
    )
    doctor = StaffUser(
        site_id=site.id,
        role="doctor",
        email="dr@sunrise.example",
        password_hash=hash_password(pw),
        totp_secret=new_totp_secret(),
        totp_enabled=True,
        display_name="Dr. Rao",
    )
    newdoc = StaffUser(
        site_id=site.id,
        role="doctor",
        email="new.doctor@sunrise.example",
        password_hash=hash_password(pw),
        display_name="Dr. New",
    )
    desk = StaffUser(
        site_id=site.id,
        role="receptionist",
        email="desk@sunrise.example",
        password_hash=hash_password(pw),
        totp_secret=new_totp_secret(),
        totp_enabled=True,
        display_name="Front desk",
    )
    doctor2 = StaffUser(
        site_id=site.id,
        role="doctor",
        email="dr.iyer@sunrise.example",
        password_hash=hash_password(pw),
        totp_secret=new_totp_secret(),
        totp_enabled=True,
        display_name="Dr. Iyer",
    )
    db.add_all([admin, doctor, newdoc, desk, doctor2])
    db.commit()
    print(
        json.dumps(
            {  # noqa: T201
                "site_id": site.id,
                "root_email": root.email,
                "root_totp": root.totp_secret,
                "admin_email": admin.email,
                "admin_totp": admin.totp_secret,
                "doctor_email": doctor.email,
                "doctor_totp": doctor.totp_secret,
                "new_doctor_email": newdoc.email,
                "desk_email": desk.email,
                "desk_totp": desk.totp_secret,
                "doctor2_email": doctor2.email,
                "doctor2_totp": doctor2.totp_secret,
            }
        )
    )
