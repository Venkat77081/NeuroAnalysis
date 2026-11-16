"""M10: hospitals as tenants, dashboard sign-in with two-step codes, operators, phones and patient
invites. Uses the dummy e-mail / SMS providers and connector."""

import re
from datetime import UTC, datetime, timedelta

import pytest

from app.providers import OUTBOX
from app.security import totp_code

SESSION = {
    "client_session_id": "home-1",
    "med_state": "OFF",
    "started_at": "2026-11-15T10:00:00Z",
    "consent_version": "home-consent@1",
    "consent_at": "2026-11-15T09:59:00Z",
    "app_version": "0.4.0",
    "config_versions": {"session": "SESSION@2.4.0"},
}


PW = "correct-horse-42"  # noqa: S105 - test password
NEW_PW = "clinic-phone-77"  # noqa: S105 - test password


def hdr(tok):
    return {"Authorization": f"Bearer {tok}"}


@pytest.fixture(autouse=True)
def _clean():
    OUTBOX.clear()
    yield
    OUTBOX.clear()


def last_link(prefix: str) -> str:
    body = OUTBOX[-1].body
    m = re.search(re.escape(prefix) + r"[A-Za-z0-9_\-]+", body)
    assert m, body
    return m.group(0)


def invite_token(link: str) -> str:
    return link.split("t=", 1)[1]


def sign_up(api, email: str, password=PW):
    """Accept the newest staff invite, sign in, set up two-step; returns access token."""
    tok = invite_token(last_link("http://localhost:5174/invite?t="))
    assert api.post("/staff/invite/accept", json={"token": tok, "password": password}).status_code == 204
    r = api.post("/staff/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    setup_tok = r.json()["tokens"]
    assert setup_tok["two_step_setup_required"] and setup_tok["refresh_token"] is None
    # A set-up-only token is refused by role-checked endpoints.
    assert api.get("/platform/hospitals", headers=hdr(setup_tok["access_token"])).status_code == 403
    secret = api.post("/staff/two-step/setup", headers=hdr(setup_tok["access_token"])).json()["secret"]
    r = api.post(
        "/staff/two-step/confirm", json={"code": totp_code(secret)}, headers=hdr(setup_tok["access_token"])
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"], secret


def staff_login(api, email, secret, password=PW):
    r = api.post("/staff/login", json={"email": email, "password": password})
    ch = r.json()["challenge_token"]
    r = api.post("/staff/login/two-step", json={"challenge_token": ch, "code": totp_code(secret)})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def platform(api):
    from app.admin import create_platform_admin
    from app.db import _factory

    with _factory()() as db:
        _, link = create_platform_admin(db, "Root@Example.org", "Root")
    tok = invite_token(link)
    assert api.post("/staff/invite/accept", json={"token": tok, "password": "short"}).status_code == 422
    assert (
        api.post("/staff/invite/accept", json={"token": tok, "password": "correct-horse-42"}).status_code
        == 204
    )
    assert (
        api.post("/staff/invite/accept", json={"token": tok, "password": "correct-horse-42"}).status_code
        == 403
    )
    r = api.post("/staff/login", json={"email": "root@example.org", "password": "correct-horse-42"}).json()
    t = r["tokens"]["access_token"]
    secret = api.post("/staff/two-step/setup", headers=hdr(t)).json()["secret"]
    assert api.post("/staff/two-step/confirm", json={"code": "000000"}, headers=hdr(t)).status_code == 400
    r = api.post("/staff/two-step/confirm", json={"code": totp_code(secret)}, headers=hdr(t))
    return r.json()["access_token"]


def onboard(api, ptok, name, email, sms=False):
    r = api.post(
        "/platform/hospitals",
        headers=hdr(ptok),
        json={"name": name, "region": "IN", "city": "Chennai", "admin_email": email, "sms_enabled": sms},
    )
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "invited"
    assert OUTBOX[-1].channel == "email" and OUTBOX[-1].to == email
    return r.json()["id"]


@pytest.fixture
def two_hospitals(api, platform):
    a = onboard(api, platform, "Sunrise Neuro Clinic", "admin@sunrise.example")
    a_tok, a_secret = sign_up(api, "admin@sunrise.example")
    b = onboard(api, platform, "Lakeview Hospital", "admin@lakeview.example", sms=True)
    b_tok, _ = sign_up(api, "admin@lakeview.example")
    # Front desk of each hospital: patients and invites are theirs (decision 031).
    desks = {}
    for k, tok, email in (
        ("a", a_tok, "frontdesk@sunrise.example"),
        ("b", b_tok, "frontdesk@lakeview.example"),
    ):
        api.post("/hospital/staff", headers=hdr(tok), json={"email": email, "role": "receptionist"})
        desks[k], _ = sign_up(api, email)
    return {
        "platform": platform,
        "a": a,
        "a_tok": a_tok,
        "a_secret": a_secret,
        "b": b,
        "b_tok": b_tok,
        "a_desk": desks["a"],
        "b_desk": desks["b"],
    }


def register_phone(api, tok, label="Ward phone 1"):
    code = api.post("/hospital/device-codes", headers=hdr(tok), json={"label": label}).json()["code"]
    r = api.post(
        "/auth/device-register",
        json={
            "enrollment_code": code.lower(),
            "model": "Pixel",
            "os_version": "16",
            "camera_check": {"effective_fps": 60},
        },
    )
    assert r.status_code == 201, r.text
    again = api.post(
        "/auth/device-register",
        json={
            "enrollment_code": code,
            "model": "Pixel",
            "os_version": "16",
            "camera_check": {"effective_fps": 60},
        },
    )
    assert again.status_code == 403  # one-time code
    return r.json()


def test_onboarding_activates_hospital_and_logs_who(api, two_hospitals):
    t = two_hospitals
    hs = {h["id"]: h for h in api.get("/platform/hospitals", headers=hdr(t["platform"])).json()}
    assert hs[t["a"]]["status"] == "active" and hs[t["a"]]["onboarded_by"]
    assert hs[t["a"]]["data_mode"] == "byo" and hs[t["a"]]["modules"] == {"clinic": True, "home": True}
    actions = [e["action"] for e in api.get("/platform/audit", headers=hdr(t["platform"])).json()]
    assert "hospital_onboarded" in actions and "hospital_activated" in actions
    # Hospital admins cannot use the platform API.
    assert api.get("/platform/hospitals", headers=hdr(t["a_tok"])).status_code == 403
    # Two-step sign-in after set-up; refresh rotates.
    toks = staff_login(api, "admin@sunrise.example", t["a_secret"])
    r = api.post("/staff/refresh", json={"refresh_token": toks["refresh_token"]})
    assert r.status_code == 200
    assert api.post("/staff/refresh", json={"refresh_token": toks["refresh_token"]}).status_code == 401
    me = api.get("/staff/me", headers=hdr(r.json()["access_token"])).json()
    assert me["site_name"] == "Sunrise Neuro Clinic" and me["two_step_enabled"]


def test_staff_lockout_and_unlock(api, two_hospitals):
    t = two_hospitals
    r = api.post(
        "/hospital/staff", headers=hdr(t["a_tok"]), json={"email": "dr@sunrise.example", "role": "doctor"}
    )
    assert r.status_code == 201
    doc_id = r.json()["id"]
    _, doc_secret = sign_up(api, "dr@sunrise.example")
    for _ in range(10):
        assert (
            api.post("/staff/login", json={"email": "dr@sunrise.example", "password": "nope"}).status_code
            == 401
        )
    r = api.post("/staff/login", json={"email": "dr@sunrise.example", "password": "correct-horse-42"})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "account_locked"
    staff = {u["id"]: u for u in api.get("/hospital/staff", headers=hdr(t["a_tok"])).json()}
    assert staff[doc_id]["locked"]
    api.post(f"/hospital/staff/{doc_id}/active", headers=hdr(t["a_tok"]), json={"active": True})
    r = api.post("/staff/login", json={"email": "dr@sunrise.example", "password": "correct-horse-42"})
    assert r.status_code == 200 and r.json()["challenge_token"]
    # Doctors cannot manage the team; e-mail addresses are unique regardless of case.
    doc = staff_login(api, "dr@sunrise.example", doc_secret)
    r = api.post("/hospital/staff", json={"email": "x@y.example"}, headers=hdr(doc["access_token"]))
    assert r.status_code == 403
    assert api.get("/hospital/patients", headers=hdr(doc["access_token"])).status_code == 200
    r = api.post("/hospital/staff", json={"email": "DR@sunrise.example"}, headers=hdr(t["a_tok"]))
    assert r.status_code == 409


def test_operator_temporary_password_must_change(api, two_hospitals):
    t = two_hospitals
    r = api.post("/hospital/operators", headers=hdr(t["a_tok"]), json={"code": "op-07"})
    assert r.status_code == 201
    op = r.json()
    assert op["code"] == "OP-07" and op["must_change_password"] and len(op["temporary_password"]) == 14
    listed = api.get("/hospital/operators", headers=hdr(t["a_tok"])).json()
    assert listed[0]["temporary_password"] is None  # shown once only
    dev = register_phone(api, t["a_tok"])
    creds = {"device_id": dev["device_id"], "device_secret": dev["device_secret"], "operator_code": "OP-07"}
    r = api.post("/auth/login", json={**creds, "password": op["temporary_password"]})
    assert r.status_code == 200 and r.json()["must_change_password"]
    tok = r.json()["access_token"]
    r = api.post("/sessions", headers=hdr(tok), json={**SESSION, "patient": {"ncid": "nc_" + "0" * 32}})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "password_change_required"
    body = {"current_password": op["temporary_password"], "new_password": "weak"}
    assert api.post("/auth/change-password", headers=hdr(tok), json=body).status_code == 422
    body["new_password"] = NEW_PW
    assert api.post("/auth/change-password", headers=hdr(tok), json=body).status_code == 204
    r = api.post("/auth/login", json={**creds, "password": "clinic-phone-77"})
    assert r.status_code == 200 and not r.json()["must_change_password"]
    # Reset and disable revoke the operator's refresh tokens.
    refresh = r.json()["refresh_token"]
    api.post(f"/hospital/operators/{op['id']}/reset-password", headers=hdr(t["a_tok"]))
    assert api.post("/auth/refresh", json={"refresh_token": refresh}).status_code == 401
    api.post(f"/hospital/operators/{op['id']}/active", headers=hdr(t["a_tok"]), json={"active": False})
    assert api.post("/auth/login", json={**creds, "password": "clinic-phone-77"}).status_code == 401


def test_device_code_expires(api, two_hospitals):
    from app.db import _factory
    from app.models import DeviceEnrollment

    code = api.post("/hospital/device-codes", headers=hdr(two_hospitals["a_tok"]), json={}).json()["code"]
    with _factory()() as db:
        for e in db.query(DeviceEnrollment):
            e.expires_at = datetime.now(UTC) - timedelta(minutes=1)
        db.commit()
    r = api.post(
        "/auth/device-register",
        json={
            "enrollment_code": code,
            "model": "P",
            "os_version": "1",
            "camera_check": {"effective_fps": 60},
        },
    )
    assert r.status_code == 403


def accept_patient(api, link, pin="2580"):
    tok = invite_token(link)
    info = api.post("/patient/invite/lookup", json={"token": tok})
    assert info.status_code == 200 and info.json()["hospital"] == "Sunrise Neuro Clinic"
    r = api.post(
        "/patient/invite/accept",
        json={
            "token": tok,
            "pin": pin,
            "consent_version": "home-consent@1",
            "model": "Galaxy",
            "os_version": "15",
            "camera_check": {"effective_fps": 60},
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def test_patient_invite_pin_and_home_session(api, two_hospitals):
    t = two_hospitals
    r = api.post("/hospital/patients/invite", headers=hdr(t["a_desk"]), json={"channel": "print"})
    assert r.status_code == 201, r.text
    ncid = r.json()["ncid"]
    assert re.fullmatch(r"nc_[0-9a-f]{32}", ncid) and r.json()["invite_link"].startswith("neurocapture://")
    # The platform never takes a patient's contact details or MRN (decision 027): e-mail / SMS
    # invites go through the hospital connector.
    for body in (
        {"channel": "email", "contact": "patient@example.org"},
        {"channel": "print", "contact": "patient@example.org"},
        {"channel": "print", "mrn": "00012388"},
        {"channel": "sms"},
    ):
        assert api.post("/hospital/patients/invite", headers=hdr(t["a_desk"]), json=body).status_code == 422

    link = r.json()["invite_link"]

    bad = api.post(
        "/patient/invite/accept",
        json={
            "token": invite_token(link),
            "pin": "12",
            "consent_version": "home-consent@1",
            "model": "G",
            "os_version": "1",
            "camera_check": {"effective_fps": 60},
        },
    )
    assert bad.status_code == 422
    acc = accept_patient(api, link)
    assert acc["ncid"] == ncid
    assert (
        api.post("/patient/invite/lookup", json={"token": invite_token(link)}).status_code == 403
    )  # single use

    tok = acc["tokens"]["access_token"]
    r = api.post("/sessions", headers=hdr(tok), json=SESSION)
    assert r.status_code == 201, r.text
    from app.db import _factory
    from app.models import Patient, Session

    with _factory()() as db:
        s = db.get(Session, r.json()["id"])
        assert s.recorded_by == "patient" and s.operator_id is None
        assert db.get(Patient, s.patient_id).ncid == ncid
    # A patient cannot record for someone else, nor use dashboard endpoints.
    other = {**SESSION, "client_session_id": "home-2", "patient": {"ncid": "nc_" + "1" * 32}}
    assert api.post("/sessions", headers=hdr(tok), json=other).status_code in (403, 422)
    assert api.get("/hospital/patients", headers=hdr(tok)).status_code == 403
    assert api.get("/patient/me", headers=hdr(tok)).json()["hospital"] == "Sunrise Neuro Clinic"

    # Operators record for the patient by NCID.
    dev = register_phone(api, t["a_tok"])
    op = api.post("/hospital/operators", headers=hdr(t["a_tok"]), json={"code": "OP-1"}).json()
    creds = {"device_id": dev["device_id"], "device_secret": dev["device_secret"], "operator_code": "OP-1"}
    otok = api.post("/auth/login", json={**creds, "password": op["temporary_password"]}).json()[
        "access_token"
    ]
    api.post(
        "/auth/change-password",
        headers=hdr(otok),
        json={"current_password": op["temporary_password"], "new_password": "clinic-phone-77"},
    )
    otok = api.post("/auth/login", json={**creds, "password": "clinic-phone-77"}).json()["access_token"]
    r = api.post(
        "/sessions",
        headers=hdr(otok),
        json={**SESSION, "client_session_id": "c-1", "patient": {"ncid": ncid}},
    )
    assert r.status_code == 201, r.text
    r = api.post(
        "/sessions",
        headers=hdr(otok),
        json={**SESSION, "client_session_id": "c-2", "patient": {"ncid": "nc_" + "2" * 32}},
    )
    assert r.status_code == 404


def test_patient_pin_lockout_and_reinvite(api, two_hospitals):
    t = two_hospitals
    link = api.post("/hospital/patients/invite", headers=hdr(t["a_desk"]), json={"channel": "print"}).json()
    assert link["invite_link"].startswith("neurocapture://invite?t=")
    acc = accept_patient(api, link["invite_link"])
    creds = {"device_id": acc["device_id"], "device_secret": acc["device_secret"]}
    ok = api.post("/patient/login", json={**creds, "pin": "2580"})
    assert ok.status_code == 200
    refresh = ok.json()["refresh_token"]
    assert api.post("/patient/refresh", json={"refresh_token": refresh}).status_code == 200
    for _ in range(4):
        assert api.post("/patient/login", json={**creds, "pin": "0000"}).status_code == 401
    r = api.post("/patient/login", json={**creds, "pin": "0000"})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "pin_locked"
    assert api.post("/patient/login", json={**creds, "pin": "2580"}).status_code == 403
    pts = api.get("/hospital/patients", headers=hdr(t["a_tok"])).json()
    assert pts[0]["status"] == "locked"
    # Re-invite: old phone removed, new link works.
    r = api.post(
        f"/hospital/patients/{link['ncid']}/reinvite", headers=hdr(t["a_desk"]), json={"channel": "print"}
    )
    assert r.status_code == 200
    assert api.post("/patient/login", json={**creds, "pin": "2580"}).status_code == 401
    acc2 = accept_patient(api, r.json()["invite_link"], pin="135790")
    assert acc2["ncid"] == link["ncid"]
    # Close: the phone stops working.
    assert api.post(f"/hospital/patients/{link['ncid']}/close", headers=hdr(t["a_tok"])).status_code == 204
    creds2 = {"device_id": acc2["device_id"], "device_secret": acc2["device_secret"]}
    assert api.post("/patient/login", json={**creds2, "pin": "135790"}).status_code == 401


def test_cross_hospital_isolation(api, two_hospitals):
    t = two_hospitals
    a, b = hdr(t["a_tok"]), hdr(t["b_tok"])
    op_a = api.post("/hospital/operators", headers=a, json={"code": "OP-07"}).json()
    dev_a = register_phone(api, t["a_tok"])
    pat_a = api.post("/hospital/patients/invite", headers=hdr(t["a_desk"]), json={"channel": "print"}).json()
    doc_a = api.post("/hospital/staff", headers=a, json={"email": "dr@sunrise.example"}).json()
    # Same operator ID is fine in another hospital.
    assert api.post("/hospital/operators", headers=b, json={"code": "OP-07"}).status_code == 201

    assert [o["code"] for o in api.get("/hospital/operators", headers=b).json()] == ["OP-07"]
    assert all(o["id"] != op_a["id"] for o in api.get("/hospital/operators", headers=b).json())
    assert api.get("/hospital/devices", headers=b).json() == []
    assert api.get("/hospital/patients", headers=b).json() == []
    assert all(u["id"] != doc_a["id"] for u in api.get("/hospital/staff", headers=b).json())
    assert all(e["site_id"] == t["b"] for e in api.get("/hospital/audit", headers=b).json())

    assert api.post(f"/hospital/operators/{op_a['id']}/reset-password", headers=b).status_code == 404
    assert (
        api.post(f"/hospital/operators/{op_a['id']}/active", headers=b, json={"active": False}).status_code
        == 404
    )
    assert api.post(f"/hospital/devices/{dev_a['device_id']}/revoke", headers=b).status_code == 404
    assert api.post(f"/auth/devices/{dev_a['device_id']}/revoke", headers=b).status_code == 404
    assert (
        api.post(
            f"/hospital/patients/{pat_a['ncid']}/reinvite",
            headers=hdr(t["b_desk"]),
            json={"channel": "print"},
        ).status_code
        == 404
    )
    assert api.post(f"/hospital/patients/{pat_a['ncid']}/close", headers=b).status_code == 404
    assert (
        api.post(f"/hospital/staff/{doc_a['id']}/active", headers=b, json={"active": False}).status_code
        == 404
    )

    # Hospital B's operator cannot sign in on hospital A's phone.
    op_b = api.get("/hospital/operators", headers=b).json()[0]
    r = api.post(f"/hospital/operators/{op_b['id']}/reset-password", headers=b).json()
    creds = {
        "device_id": dev_a["device_id"],
        "device_secret": dev_a["device_secret"],
        "operator_code": "OP-07",
    }
    assert api.post("/auth/login", json={**creds, "password": r["temporary_password"]}).status_code == 401


def test_suspended_hospital_is_refused(api, two_hospitals):
    t = two_hospitals
    pat = api.post("/hospital/patients/invite", headers=hdr(t["a_desk"]), json={"channel": "print"}).json()
    acc = accept_patient(api, pat["invite_link"])
    r = api.post(
        f"/platform/hospitals/{t['a']}/status", headers=hdr(t["platform"]), json={"status": "suspended"}
    )
    assert r.json()["status"] == "suspended"
    assert api.get("/hospital/operators", headers=hdr(t["a_tok"])).status_code == 403
    assert (
        api.post(
            "/patient/login",
            json={"device_id": acc["device_id"], "device_secret": acc["device_secret"], "pin": "2580"},
        ).status_code
        == 403
    )
    assert api.post("/sessions", headers=hdr(acc["tokens"]["access_token"]), json=SESSION).status_code == 403
    assert api.get("/hospital/operators", headers=hdr(t["b_tok"])).status_code == 200
    api.post(f"/platform/hospitals/{t['a']}/status", headers=hdr(t["platform"]), json={"status": "active"})
    assert api.get("/hospital/operators", headers=hdr(t["a_tok"])).status_code == 200


def test_no_patient_identity_columns():
    """Decision 023: no table may hold a patient's name, MRN, e-mail, phone or address."""
    from app.models import Base

    banned = re.compile(r"(name|mrn|email|e_mail|phone|mobile|address|dob|birth_date|contact)", re.I)
    allowed = {
        ("sites", "name"),
        ("staff_users", "email"),
        ("staff_users", "display_name"),
        ("operators", "display_name_hash"),
        # Staff, not patients (user, 16 Nov 2026: activity logs name the person).
        ("operators", "name"),
    }
    patient_tables = {
        "patients",
        "patient_accounts",
        "patient_refresh_tokens",
        "sessions",
        "takes",
        "take_files",
    }
    found = []
    for table in Base.metadata.sorted_tables:
        for col in table.columns:
            if banned.search(col.name) and (table.name, col.name) not in allowed:
                found.append(f"{table.name}.{col.name}")
            if table.name in patient_tables and banned.search(col.name):
                found.append(f"{table.name}.{col.name}")
    assert found == []


def test_platform_refuses_patient_identity(api, two_hospitals):
    t = two_hospitals
    r = api.post(
        "/hospital/patients/invite",
        headers=hdr(t["a_desk"]),
        json={"channel": "email", "contact": "patient@example.org", "mrn": "MRN-99887766"},
    )
    assert r.status_code == 422
    rows = str(api.get("/hospital/audit", headers=hdr(t["a_tok"])).json())
    assert "patient@example.org" not in rows and "MRN-99887766" not in rows


def test_phones_list_counts_takes_below_the_minimum(api, two_hospitals):
    """User, 16 Nov 2026: Phones list shows takes in the last 30 days and how many were below 59 fps,
    retakes included (the phone reports each attempt's fps when it closes a session)."""
    t = two_hospitals
    op = api.post(
        "/hospital/operators", headers=hdr(t["a_tok"]), json={"code": "op-09", "name": "Kavya R"}
    ).json()
    dev = register_phone(api, t["a_tok"], label="OPD desk phone")
    creds = {"device_id": dev["device_id"], "device_secret": dev["device_secret"], "operator_code": "OP-09"}
    tok = api.post("/auth/login", json={**creds, "password": op["temporary_password"]}).json()["access_token"]
    body = {"current_password": op["temporary_password"], "new_password": NEW_PW}
    assert api.post("/auth/change-password", headers=hdr(tok), json=body).status_code == 204
    tok = api.post("/auth/login", json={**creds, "password": NEW_PW}).json()["access_token"]

    ncid = api.post("/hospital/patients/invite", headers=hdr(t["a_desk"]), json={"channel": "print"}).json()[
        "ncid"
    ]
    now = datetime.now(UTC)

    def session(cid, started, attempts):
        r = api.post(
            "/sessions",
            headers=hdr(tok),
            json={
                **SESSION,
                "client_session_id": cid,
                "started_at": started.isoformat(),
                "patient": {"ncid": ncid},
            },
        )
        assert r.status_code == 201, r.text
        close = {"ended_at": (started + timedelta(minutes=20)).isoformat()}
        if attempts is not None:
            close["attempt_fps"] = attempts
        assert api.post(f"/sessions/{r.json()['id']}/close", headers=hdr(tok), json=close).status_code == 200
        return r.json()["id"]

    session("s-1", now - timedelta(days=2), [59.9, 57.2, 60.0, 58.4])  # 2 retakes below 59
    session("s-2", now - timedelta(days=40), [50.0])  # older than 30 days: not counted
    old_app = session("s-3", now - timedelta(days=1), None)  # an app without attempt_fps
    from app.db import _factory
    from app.models import Take

    with _factory()() as db:  # its uploaded takes count instead
        for i, fps in enumerate([59.5, 56.0]):
            db.add(
                Take(
                    client_take_id=f"tk-{i}",
                    session_id=old_app,
                    test_code="FT",
                    take_no=1,
                    capture_verdict="PASS",
                    quality={"fpsEffective": fps},
                    meta={},
                    wrapped_data_key="x",
                    key_id="k",
                )
            )
        db.commit()
    bad = api.post(
        f"/sessions/{old_app}/close",
        headers=hdr(tok),
        json={"ended_at": now.isoformat(), "attempt_fps": [300]},
    )
    assert bad.status_code == 422

    phones = {d["id"]: d for d in api.get("/hospital/devices", headers=hdr(t["a_tok"])).json()}
    d = phones[dev["device_id"]]
    assert (d["takes_recent"], d["takes_below_min"], d["check_fps"]) == (6, 3, 60.0)


def test_staff_invites_over_smtp_and_resend_when_mail_was_down(api, two_hospitals, monkeypatch):
    """Real e-mail (user, 16 Nov 2026): staff invites go out over SMTP. If the mail server is down,
    the person is still added (502 email_not_sent) and "Resend invite" works once mail is back."""
    from fake_smtp import FakeSmtp

    from app.config import get_settings

    t = two_hospitals
    s = get_settings()
    dead = FakeSmtp()
    dead_port = dead.port
    dead.close()
    for k, v in {
        "email_provider": "smtp",
        "smtp_host": "127.0.0.1",
        "smtp_port": dead_port,
        "smtp_security": "none",
        "smtp_username": "AKIAEXAMPLE",
        "smtp_password": "ses-smtp-password",
        "mail_from": "no-reply@neurocapture.example",
        "mail_from_name": "NeuroCapture",
        "smtp_timeout_s": 3.0,
    }.items():
        monkeypatch.setattr(s, k, v)

    r = api.post(
        "/hospital/staff", headers=hdr(t["a_tok"]), json={"email": "dr.rao@sunrise.example", "role": "doctor"}
    )
    assert r.status_code == 502 and r.json()["detail"]["code"] == "email_not_sent"
    staff = {u["email"]: u for u in api.get("/hospital/staff", headers=hdr(t["a_tok"])).json()}
    assert "dr.rao@sunrise.example" in staff  # saved; only the e-mail failed

    smtp = FakeSmtp()
    try:
        monkeypatch.setattr(s, "smtp_port", smtp.port)
        uid = staff["dr.rao@sunrise.example"]["id"]
        assert api.post(f"/hospital/staff/{uid}/resend-invite", headers=hdr(t["a_tok"])).status_code == 204
        assert smtp.logins == [("AKIAEXAMPLE", "ses-smtp-password")]
        msg = smtp.messages[0]
        assert msg["To"] == "dr.rao@sunrise.example"
        assert msg["From"] == "NeuroCapture <no-reply@neurocapture.example>"
        assert "Sunrise Neuro Clinic" in msg["Subject"]
        body = msg.get_payload(decode=True).decode()
        token = body.split("/invite?t=", 1)[1].split()[0]
        # The link in the e-mail works.
        ok = api.post("/staff/invite/accept", json={"token": token, "password": PW})
        assert ok.status_code == 204, ok.text
    finally:
        smtp.close()
