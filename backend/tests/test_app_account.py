"""v11 (decision 043): the patient app account. E-mail only as a fingerprint, one app PIN, an
encrypted backup the platform cannot open, moving to a new phone, and forgot PIN."""

import re

from sqlalchemy import select
from test_tenancy import (  # noqa: F401 - fixtures
    _clean,
    hdr,
    invite_token,
    platform,
    two_hospitals,
)

from app.providers import OUTBOX

EMAIL = "Asha.T@Example.com"
PHONE_A = {"install_id": "install-aaaaaaaa", "device_label": "Pixel 7 · Android 15"}
PHONE_B = {"install_id": "install-bbbbbbbb", "device_label": "Galaxy A55 · Android 15"}
CAM = {"effective_fps": 60}


def code(api, purpose, email=EMAIL):
    OUTBOX.clear()
    r = api.post("/account/code", json={"email": email, "purpose": purpose})
    assert r.status_code == 202, r.text
    (msg,) = OUTBOX
    assert msg.to == email
    return re.search(r"\b(\d{6})\b", msg.subject).group(1)


def signup(api, pin="2580"):
    r = api.post(
        "/account/signup",
        json={
            "email": EMAIL,
            "code": code(api, "signup"),
            "pin": pin,
            "kdf_salt": "c2FsdHNhbHRzYWx0c2FsdA",
            "recovery_check": "cmVjb3ZlcnktY2hlY2stdmFsdWU",
            **PHONE_A,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def join(api, t, account_token):
    inv = api.post("/hospital/patients/invite", headers=hdr(t["a_desk"]), json={"channel": "print"}).json()
    r = api.post(
        "/patient/invite/accept",
        json={
            "token": invite_token(inv["invite_link"]),
            "account_token": account_token,
            "model": "Pixel 7",
            "os_version": "15",
            "camera_check": CAM,
        },
    )
    assert r.status_code == 201, r.text
    return inv["ncid"], r.json()


def test_signup_join_without_pin_and_what_is_stored(api, two_hospitals):
    from app.db import _factory
    from app.models import AppAccount, PatientAccount

    t = two_hospitals
    acc = signup(api)
    assert acc["share"] and acc["backup"] is None
    # Joining needs no hospital PIN, only a live app account; without either it is refused.
    ncid, joined = join(api, t, acc["tokens"]["access_token"])
    inv = api.post("/hospital/patients/invite", headers=hdr(t["a_desk"]), json={"channel": "print"}).json()
    bad = api.post(
        "/patient/invite/accept",
        json={
            "token": invite_token(inv["invite_link"]),
            "model": "x",
            "os_version": "1",
            "camera_check": CAM,
        },
    )
    assert bad.status_code == 422
    # The hospital sign-in works with the phone's secret alone.
    r = api.post(
        "/patient/login", json={"device_id": joined["device_id"], "device_secret": joined["device_secret"]}
    )
    assert r.status_code == 200, r.text
    # The phone saves its sealed backup (opaque here).
    put = api.put(
        "/account/backup",
        headers=hdr(acc["tokens"]["access_token"]),
        json={"backup": "c2VhbGVkLWJhY2t1cC1ibG9i", "wrap_pin": "d3JhcC1waW4tYmxvYi14eA"},
    )
    assert put.status_code == 204, put.text
    with _factory()() as db:
        row = db.scalar(select(AppAccount))
        assert "asha" not in row.email_fp.lower() and len(row.email_fp) == 64  # fingerprint, not the address
        assert row.backup == "c2VhbGVkLWJhY2t1cC1ibG9i"
        assert (
            db.scalar(select(PatientAccount).where(PatientAccount.device_id == joined["device_id"])).pin_hash
            is None
        )
        # No column links the account to a hospital or NCID.
        assert ncid not in str(vars(row))
    assert (
        api.post(
            "/account/signup",
            json={
                "email": EMAIL,
                "code": code(api, "signup"),
                "pin": "2580",
                "kdf_salt": "c2FsdHNhbHRzYWx0c2FsdA",
                "recovery_check": "cmVjb3ZlcnktY2hlY2stdmFsdWU",
                **PHONE_A,
            },
        ).status_code
        == 409
    )


def test_new_phone_moves_the_account_and_each_hospital(api, two_hospitals):
    t = two_hospitals
    acc = signup(api)
    _, joined = join(api, t, acc["tokens"]["access_token"])
    api.put(
        "/account/backup",
        headers=hdr(acc["tokens"]["access_token"]),
        json={"backup": "c2VhbGVkLWJhY2t1cC1ibG9i", "wrap_pin": "d3JhcC1waW4tYmxvYi14eA"},
    )
    # New phone: wrong code, then wrong PIN (counted), then "use this phone?".
    c = code(api, "signin")
    assert (
        api.post(
            "/account/signin", json={"email": EMAIL, "code": "000000", "pin": "2580", **PHONE_B}
        ).status_code
        == 401
    )
    wrong = api.post("/account/signin", json={"email": EMAIL, "code": c, "pin": "1111", **PHONE_B})
    assert wrong.status_code == 401 and wrong.json()["detail"]["left"] == 4
    other = api.post("/account/signin", json={"email": EMAIL, "code": c, "pin": "2580", **PHONE_B})
    assert other.status_code == 409 and other.json()["detail"]["device_label"].startswith("Pixel 7")
    moved = api.post(
        "/account/signin", json={"email": EMAIL, "code": c, "pin": "2580", "move": True, **PHONE_B}
    )
    assert moved.status_code == 200, moved.text
    body = moved.json()
    assert body["backup"] == "c2VhbGVkLWJhY2t1cC1ibG9i" and body["share"] == acc["share"]
    # The old phone is signed out of the account ...
    old = api.post("/account/refresh", json={"refresh_token": acc["tokens"]["refresh_token"]})
    assert old.status_code == 401 and old.json()["detail"]["code"] == "moved"
    # ... and, once the new phone rotates each hospital, of that hospital too.
    rot = api.post(
        "/patient/device/rotate",
        json={
            "device_id": joined["device_id"],
            "device_secret": joined["device_secret"],
            "model": "Galaxy A55",
            "os_version": "15",
            "camera_check": CAM,
        },
    )
    assert rot.status_code == 200, rot.text
    assert (
        api.post("/patient/refresh", json={"refresh_token": joined["tokens"]["refresh_token"]}).status_code
        == 401
    )
    assert (
        api.post(
            "/patient/login",
            json={"device_id": rot.json()["device_id"], "device_secret": rot.json()["device_secret"]},
        ).status_code
        == 200
    )
    assert (
        api.post(
            "/patient/device/rotate",
            json={
                "device_id": joined["device_id"],
                "device_secret": joined["device_secret"],
                "model": "x",
                "os_version": "1",
                "camera_check": CAM,
            },
        ).status_code
        == 401
    )


def test_unlock_counts_wrong_pins_and_pauses(api, two_hospitals):
    acc = signup(api)
    rt = acc["tokens"]["refresh_token"]
    for left in (4, 3, 2, 1):
        r = api.post("/account/unlock", json={"refresh_token": rt, "pin": "9999"})
        assert r.status_code == 401 and r.json()["detail"]["left"] == left
    paused = api.post("/account/unlock", json={"refresh_token": rt, "pin": "9999"})
    assert paused.status_code == 403 and paused.json()["detail"]["code"] == "paused"
    assert api.post("/account/unlock", json={"refresh_token": rt, "pin": "2580"}).status_code == 403


def test_forgot_pin_with_recovery_code_or_last_resort(api, two_hospitals):
    acc = signup(api)
    api.put(
        "/account/backup",
        headers=hdr(acc["tokens"]["access_token"]),
        json={
            "backup": "c2VhbGVkLWJhY2t1cC1ibG9i",
            "wrap_pin": "d3JhcC1waW4tYmxvYi14eA",
            "wrap_recovery": "d3JhcC1yZWNvdmVyeS1ibG9i",
            "recovery_check": "cmVjb3ZlcnktY2hlY2stdmFsdWU",
        },
    )
    c = code(api, "recover")
    rec = api.post("/account/recover", json={"email": EMAIL, "code": c})
    assert rec.status_code == 200 and rec.json()["wrap_recovery"] == "d3JhcC1yZWNvdmVyeS1ibG9i"
    base = {"email": EMAIL, "code": c, "new_pin": "135790", "kdf_salt": "bmV3c2FsdG5ld3NhbHRuZXc", **PHONE_A}
    assert (
        api.post("/account/reset-pin", json={**base, "recovery_check": "d3Jvbmctd3Jvbmctd3Jvbmc"}).status_code
        == 403
    )
    ok = api.post("/account/reset-pin", json={**base, "recovery_check": "cmVjb3ZlcnktY2hlY2stdmFsdWU"})
    assert ok.status_code == 200, ok.text
    # Old sessions end; the new PIN works; the backup is kept for the phone to lock again.
    assert (
        api.post("/account/refresh", json={"refresh_token": acc["tokens"]["refresh_token"]}).status_code
        == 401
    )
    assert (
        api.post(
            "/account/unlock", json={"refresh_token": ok.json()["tokens"]["refresh_token"], "pin": "135790"}
        ).status_code
        == 200
    )
    # Last resort without the recovery code: the backup is forgotten, the account stays.
    c2 = code(api, "recover")
    last = api.post(
        "/account/reset-pin", json={**base, "code": c2, "new_pin": "246810", "forget_backup": True}
    )
    assert last.status_code == 200
    c3 = code(api, "recover")
    assert api.post("/account/recover", json={"email": EMAIL, "code": c3}).json()["backup"] is None


def test_codes_are_limited_and_single_use(api, two_hospitals):
    for _ in range(5):
        assert (
            api.post("/account/code", json={"email": "x@example.org", "purpose": "signin"}).status_code == 202
        )
    assert api.post("/account/code", json={"email": "x@example.org", "purpose": "signin"}).status_code == 429
    # Codes never reach the audit log or the database in clear.
    from app.db import _factory
    from app.models import AppAccountCode, AuditEvent

    with _factory()() as db:
        assert all(len(r.code_hash) == 64 for r in db.scalars(select(AppAccountCode)))
        assert "example.org" not in str([e.details for e in db.scalars(select(AuditEvent))])


def test_same_phone_after_reinstall_is_not_another_phone(api, two_hospitals):
    acc = signup(api)
    c = code(api, "signin")
    r = api.post("/account/signin", json={"email": EMAIL, "code": c, "pin": "2580", **PHONE_A})
    assert r.status_code == 200, r.text  # same phone ID: no "use this phone?"
    # The earlier sign-in of that install ends; the new one works.
    assert (
        api.post("/account/refresh", json={"refresh_token": acc["tokens"]["refresh_token"]}).status_code
        == 401
    )
    assert (
        api.post("/account/refresh", json={"refresh_token": r.json()["tokens"]["refresh_token"]}).status_code
        == 200
    )
