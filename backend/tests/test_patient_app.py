"""M13 backend: recording plans, the patient's own history, consent withdrawal and deletion."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from test_readiness_api import _upload_take
from test_tenancy import (  # noqa: F401 - fixtures
    SESSION,
    _clean,
    accept_patient,
    hdr,
    platform,
    two_hospitals,
)


def home_patient(api, tok):
    inv = api.post("/hospital/patients/invite", headers=hdr(tok), json={"channel": "print"}).json()
    return inv["ncid"], accept_patient(api, inv["invite_link"])


def test_patient_history_and_withdraw_with_deletion(api, two_hospitals):
    t = two_hospitals
    ncid, acc = home_patient(api, t["a_desk"])
    _, other = home_patient(api, t["a_desk"])
    ptok = hdr(acc["tokens"]["access_token"])
    sid = api.post("/sessions", headers=ptok, json=SESSION).json()["id"]
    take_id = _upload_take(api, acc["tokens"], sid, acc["server_key"], "tk-h1")
    assert api.post(f"/takes/{take_id}/complete", headers=ptok).status_code == 200
    api.post(
        "/sessions", headers=hdr(other["tokens"]["access_token"]), json={**SESSION, "client_session_id": "x"}
    )

    hist = api.get("/patient/sessions", headers=ptok).json()
    assert [(h["id"], h["takes_uploaded"], h["recorded_by"]) for h in hist] == [(sid, 1, "patient")]
    assert api.get("/patient/sessions", headers=hdr(t["a_tok"])).status_code == 403

    r = api.post("/patient/consent/withdraw", headers=ptok, json={"delete_recordings": True})
    assert r.status_code == 200 and r.json()["status"] == "closed"
    req_id = r.json()["deletion_request_id"]
    # Signed out for good on this phone.
    assert api.get("/patient/plan", headers=ptok).status_code == 401
    login = {"device_id": acc["device_id"], "device_secret": acc["device_secret"], "pin": "2580"}
    assert api.post("/patient/login", json=login).status_code == 401
    assert (
        api.post("/patient/refresh", json={"refresh_token": acc["tokens"]["refresh_token"]}).status_code
        == 401
    )

    reqs = api.get("/hospital/deletion-requests", headers=hdr(t["a_tok"])).json()
    assert [(x["id"], x["ncid"], x["status"]) for x in reqs] == [(req_id, ncid, "pending")]
    assert api.get("/hospital/deletion-requests", headers=hdr(t["b_tok"])).json() == []
    assert api.post(f"/hospital/deletion-requests/{req_id}/done", headers=hdr(t["b_tok"])).status_code == 404
    done = api.post(f"/hospital/deletion-requests/{req_id}/done", headers=hdr(t["a_tok"])).json()
    assert done["status"] == "done"
    from app.db import _factory
    from app.models import Take, TakeFile

    with _factory()() as db:
        assert db.get(Take, take_id) is None
        assert db.query(TakeFile).filter(TakeFile.take_id == take_id).count() == 0
    actions = [e["action"] for e in api.get("/hospital/audit", headers=hdr(t["a_tok"])).json()]
    assert "consent_withdrawn" in actions and "recordings_deleted" in actions


def test_withdraw_without_deletion(api, two_hospitals):
    _, acc = home_patient(api, two_hospitals["a_desk"])
    r = api.post(
        "/patient/consent/withdraw",
        headers=hdr(acc["tokens"]["access_token"]),
        json={"delete_recordings": False},
    )
    assert r.json() == {"status": "closed", "deletion_request_id": None}


def test_operator_needs_ncid_without_legacy_hash(api, two_hospitals, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "allow_legacy_ref_hash", False)
    _, acc = home_patient(api, two_hospitals["a_desk"])
    from test_tenancy import register_phone

    t = two_hospitals
    dev = register_phone(api, t["a_tok"])
    op = api.post("/hospital/operators", headers=hdr(t["a_tok"]), json={"code": "OP-9"}).json()
    creds = {"device_id": dev["device_id"], "device_secret": dev["device_secret"], "operator_code": "OP-9"}
    tok = api.post("/auth/login", json={**creds, "password": op["temporary_password"]}).json()["access_token"]
    api.post(
        "/auth/change-password",
        headers=hdr(tok),
        json={"current_password": op["temporary_password"], "new_password": "clinic-phone-77"},
    )
    tok = api.post("/auth/login", json={**creds, "password": "clinic-phone-77"}).json()["access_token"]
    r = api.post("/sessions", headers=hdr(tok), json={**SESSION, "patient": {"ref_hash": "a" * 64}})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "ncid_required"
    # No connector registered yet: no connector token.
    assert api.post("/auth/connector-token", headers=hdr(tok)).status_code == 409


def test_operator_locks_after_wrong_passwords_and_admin_unlocks(api, two_hospitals):
    from test_tenancy import register_phone

    t = two_hospitals
    dev = register_phone(api, t["a_tok"])
    op = api.post("/hospital/operators", headers=hdr(t["a_tok"]), json={"code": "OP-L"}).json()
    creds = {"device_id": dev["device_id"], "device_secret": dev["device_secret"], "operator_code": "OP-L"}
    for _ in range(10):
        assert api.post("/auth/login", json={**creds, "password": "wrong-pass-1"}).status_code == 401
    r = api.post("/auth/login", json={**creds, "password": op["temporary_password"]})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "account_locked"
    listed = {o["id"]: o for o in api.get("/hospital/operators", headers=hdr(t["a_tok"])).json()}
    assert listed[op["id"]]["locked"]
    api.post(f"/hospital/operators/{op['id']}/active", headers=hdr(t["a_tok"]), json={"active": True})
    assert api.post("/auth/login", json={**creds, "password": op["temporary_password"]}).status_code == 200


def test_patient_list_counts_sessions_and_platform_setup_status(api, two_hospitals):
    t = two_hospitals
    ncid, acc = home_patient(api, t["a_desk"])
    api.post("/sessions", headers=hdr(acc["tokens"]["access_token"]), json=SESSION)
    rows = {r["ncid"]: r for r in api.get("/hospital/patients", headers=hdr(t["a_tok"])).json()}
    assert rows[ncid]["sessions"] == 1 and rows[ncid]["status"] == "active" and rows[ncid]["last_session_at"]
    setup = api.get(f"/platform/hospitals/{t['a']}/setup", headers=hdr(t["platform"])).json()
    assert setup["admin_accepted"] and not setup["connector_registered"] and not setup["take_key"]
    assert setup["storage_kind"] == "managed"
    assert api.get(f"/platform/hospitals/{t['a']}/setup", headers=hdr(t["a_tok"])).status_code == 403


def test_cors_allows_the_dashboard_origin(api):
    r = api.options(
        "/staff/login", headers={"Origin": "http://localhost:5174", "Access-Control-Request-Method": "POST"}
    )
    assert r.headers.get("access-control-allow-origin") == "http://localhost:5174"
    r = api.options(
        "/staff/login", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"}
    )
    assert "access-control-allow-origin" not in r.headers


def test_periodic_plan_only_when_the_doctor_asks(api, two_hospitals):
    t = two_hospitals
    ncid, acc = home_patient(api, t["a_desk"])
    # Decision 033: the plan is a doctor's permission (requests.rerecord), for assigned patients.
    dr = _staff(api, t, "plan.dr@sunrise.example", "doctor")
    dr_id = next(
        d["id"]
        for d in api.get("/hospital/doctors", headers=hdr(t["a_desk"])).json()
        if d["email"] == "plan.dr@sunrise.example"
    )
    soon = (datetime.now(UTC) + timedelta(days=3)).isoformat()
    api.post(
        "/hospital/appointments",
        headers=hdr(t["a_desk"]),
        json={"ncid": ncid, "at": soon, "doctor_id": dr_id},
    )
    assert api.put(f"/hospital/patients/{ncid}/plan", headers=hdr(t["a_tok"]), json={}).status_code == 403
    ptok = hdr(acc["tokens"]["access_token"])
    plan = api.get("/patient/plan", headers=ptok).json()
    assert plan["default"] and not plan["periodic"] and not plan["due_now"] and plan["next_due"] is None
    body = {"tests": ["FT", "FA", "FT"], "every_days": 3, "med_state": "ON", "periodic": True}
    r = api.put(f"/hospital/patients/{ncid}/plan", headers=dr, json=body)
    assert r.status_code == 200 and r.json()["tests"] == ["FT", "FA"] and r.json()["periodic"]
    assert (
        api.put(f"/hospital/patients/{ncid}/plan", headers=dr, json={**body, "note": "x"}).status_code == 422
    )
    assert api.get("/patient/plan", headers=ptok).json()["due_now"]  # periodic, never recorded
    yesterday = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    api.post("/sessions", headers=ptok, json={**SESSION, "started_at": yesterday})
    plan = api.get("/patient/plan", headers=ptok).json()
    assert not plan["due_now"] and plan["next_due"].startswith(
        (datetime.now(UTC) + timedelta(days=2)).date().isoformat()
    )
    api.put(f"/hospital/patients/{ncid}/plan", headers=dr, json={**body, "periodic": False})
    assert api.get("/patient/plan", headers=ptok).json()["next_due"] is None


def _login_doc(api, email):
    from test_tenancy import staff_login

    return hdr(staff_login(api, email, _SECRETS[email])["access_token"])


_SECRETS: dict[str, str] = {}


def _staff(api, t, email, role):
    from test_tenancy import sign_up, staff_login

    api.post("/hospital/staff", headers=hdr(t["a_tok"]), json={"email": email, "role": role})
    _, secret = sign_up(api, email)
    _SECRETS[email] = secret
    return hdr(staff_login(api, email, secret)["access_token"])


def test_appointment_request_record_and_history(api, two_hospitals):
    t = two_hospitals
    desk = _staff(api, t, "desk@sunrise.example", "receptionist")
    dr = _staff(api, t, "dr@sunrise.example", "doctor")
    dr_id = api.get("/hospital/doctors", headers=desk).json()[0]["id"]
    ncid, acc = home_patient(api, t["a_desk"])
    ptok = hdr(acc["tokens"]["access_token"])
    at = (datetime.now(UTC) + timedelta(days=3)).replace(microsecond=0)

    # Manual appointment with a doctor (assigns the patient); a FHIR one is deduplicated.
    r = api.post(
        "/hospital/appointments", headers=desk, json={"ncid": ncid, "at": at.isoformat(), "doctor_id": dr_id}
    )
    assert r.status_code == 201, r.text
    appt = r.json()
    assert appt["source"] == "manual" and appt["doctor_name"]
    assert [x["ncid"] for x in api.get("/hospital/patients", headers=dr).json()] == [
        ncid
    ]  # assigned by booking
    f1 = api.post(
        "/hospital/appointments",
        headers=desk,
        json={
            "ncid": ncid,
            "at": (at + timedelta(days=7)).isoformat(),
            "source": "fhir",
            "external_id": "Appointment/77",
        },
    )
    f2 = api.post(
        "/hospital/appointments",
        headers=desk,
        json={
            "ncid": ncid,
            "at": (at + timedelta(days=7)).isoformat(),
            "source": "fhir",
            "external_id": "Appointment/77",
        },
    )
    assert f1.json()["id"] == f2.json()["id"]
    from app.db import _factory
    from app.models import Appointment

    with _factory()() as db:
        stored = db.get(Appointment, f1.json()["id"])
        assert stored.external_ref_hash and "Appointment/77" not in stored.external_ref_hash
    assert len(api.get("/hospital/appointments", headers=desk).json()) == 1  # 7-day window
    assert len(api.get("/hospital/appointments?days=14", headers=desk).json()) == 2
    assert (
        api.post("/hospital/appointments", headers=dr, json={"ncid": ncid, "at": at.isoformat()}).status_code
        == 403
    )

    # Stages: assigned, waiting for the doctor's tests; nothing for the patient yet.
    assert appt["stage"] == "needs_tests"
    assert api.get("/patient/requests", headers=ptok).json() == []
    assert f1.json()["stage"] == "needs_doctor"

    # Only the assigned doctor sends the record link (not reception, not another doctor).
    url = f"/hospital/appointments/{appt['id']}/request"
    assert api.post(url, headers=desk, json={}).status_code == 403
    other = _staff(api, t, "dr-other@sunrise.example", "doctor")
    assert api.post(url, headers=other, json={}).status_code == 404
    # Tests from the plan, due a day before.
    rq = api.post(url, headers=dr, json={})
    assert rq.status_code == 201, rq.text
    req = rq.json()[0]
    stages = {a["id"]: a["stage"] for a in api.get("/hospital/appointments", headers=desk).json()}
    assert stages[appt["id"]] == "sent"
    assert req["tests"] == ["FT", "FTF", "FR", "SAW", "FA"] and req["state"] == "open"
    assert req["due_at"].startswith((at - timedelta(days=1)).date().isoformat())
    mine = api.get("/patient/requests", headers=ptok).json()
    assert [(m["id"], m["state"], m["kind"]) for m in mine] == [(req["id"], "open", "appointment")]
    assert mine[0]["doctor_name"] and mine[0]["appointment_at"]

    # The patient records for it (consent per session); the request becomes "recorded".
    sid = api.post("/sessions", headers=ptok, json={**SESSION, "request_id": req["id"]}).json()["id"]
    assert (
        api.post(
            "/sessions", headers=ptok, json={**SESSION, "client_session_id": "x", "request_id": "nope"}
        ).status_code
        == 422
    )
    take_id = _upload_take(api, acc["tokens"], sid, acc["server_key"], "tk-req")
    api.post(f"/takes/{take_id}/complete", headers=ptok)
    assert api.get("/patient/requests", headers=ptok).json()[0]["state"] == "recorded"
    assert api.get("/hospital/appointments", headers=dr).json()[0]["stage"] == "recorded"

    # The doctor asks to record again: a second request (re-record).
    rr = api.post(f"/hospital/patients/{ncid}/rerecord", headers=dr, json={"tests": ["FA"]})
    assert rr.status_code == 201 and rr.json()[0]["kind"] == "rerecord" and rr.json()[0]["tests"] == ["FA"]
    hist = api.get(f"/hospital/patients/{ncid}/history", headers=dr).json()
    assert [a["requests"][0]["state"] for a in hist["appointments"] if a["requests"]] == ["recorded"]
    assert [r["kind"] for r in hist["other_requests"]] == ["rerecord"]
    assert hist["sessions"][0]["request_id"] == req["id"] and hist["sessions"][0]["takes_uploaded"] == 1
    # Another hospital sees nothing.
    assert api.get(f"/hospital/patients/{ncid}/history", headers=hdr(t["b_desk"])).status_code == 404

    # Cancelling the appointment cancels its request.
    api.put(f"/hospital/appointments/{appt['id']}", headers=desk, json={"status": "cancelled"})
    hist = api.get(f"/hospital/patients/{ncid}/history", headers=desk).json()
    assert [a["stage"] for a in hist["appointments"] if a["id"] == appt["id"]] == ["cancelled"]
    # Decision 040: a completed appointment keeps the doctor's access (here: even after cancelling).
    assert api.get(f"/hospital/patients/{ncid}/history", headers=dr).status_code == 200
    # A doctor whose only appointment was cancelled, moved away or missed (never completed) may not.
    for email in ("cx@sunrise.example", "mv@sunrise.example", "ms@sunrise.example", "other@sunrise.example"):
        _staff(api, t, email, "doctor")
    ids = {d["email"]: d["id"] for d in api.get("/hospital/doctors", headers=desk).json()}
    future = (datetime.now(UTC) + timedelta(days=4)).isoformat()
    past = (datetime.now(UTC) - timedelta(days=4)).isoformat()

    def book(email, at):
        return api.post(
            "/hospital/appointments", headers=desk, json={"ncid": ncid, "at": at, "doctor_id": ids[email]}
        ).json()["id"]

    cx = book("cx@sunrise.example", future)
    mv = book("mv@sunrise.example", future)
    book("ms@sunrise.example", past)  # missed: in the past, nothing recorded
    login = {
        e: _login_doc(api, e) for e in ("cx@sunrise.example", "mv@sunrise.example", "ms@sunrise.example")
    }
    assert (
        api.get(f"/hospital/patients/{ncid}/history", headers=login["cx@sunrise.example"]).status_code == 200
    )
    api.put(f"/hospital/appointments/{cx}", headers=desk, json={"status": "cancelled"})
    api.put(f"/hospital/appointments/{mv}", headers=desk, json={"doctor_id": ids["other@sunrise.example"]})
    for e in login:
        assert api.get(f"/hospital/patients/{ncid}/history", headers=login[e]).status_code == 404, e


def test_doctor_can_add_repeat_every_n_days(api, two_hospitals):
    t = two_hospitals
    desk = _staff(api, t, "desk3@sunrise.example", "receptionist")
    dr = _staff(api, t, "dr3@sunrise.example", "doctor")
    dr_id = next(
        d["id"]
        for d in api.get("/hospital/doctors", headers=desk).json()
        if d["email"] == "dr3@sunrise.example"
    )
    ncid, acc = home_patient(api, t["a_desk"])
    ptok = hdr(acc["tokens"]["access_token"])
    at = (datetime.now(UTC) + timedelta(days=5)).isoformat()
    appt = api.post(
        "/hospital/appointments", headers=desk, json={"ncid": ncid, "at": at, "doctor_id": dr_id}
    ).json()
    assert api.get("/patient/plan", headers=ptok).json()["next_due"] is None  # appointments only
    r = api.post(
        f"/hospital/appointments/{appt['id']}/request",
        headers=dr,
        json={"tests": ["FA", "FT"], "med_state": "OFF", "repeat_every_days": 7},
    )
    assert r.status_code == 201, r.text
    assert r.json()[0]["tests"] == ["FT", "FA"]
    plan = api.get(f"/hospital/patients/{ncid}/plan", headers=dr).json()
    assert plan["periodic"] and plan["every_days"] == 7 and plan["tests"] == ["FT", "FA"]
    # Until the next appointment: it ends at the appointment (5 days away), not after it.
    assert plan["periodic_until"].startswith(at[:16])
    mine = api.get("/patient/plan", headers=ptok).json()
    assert mine["due_now"] and mine["periodic_until"]
    # Rescheduling moves the end; once the appointment has passed, the repeats stop.
    later = (datetime.now(UTC) + timedelta(days=20)).isoformat()
    api.put(f"/hospital/appointments/{appt['id']}", headers=desk, json={"at": later})
    assert (
        api.get(f"/hospital/patients/{ncid}/plan", headers=dr).json()["periodic_until"].startswith(later[:16])
    )
    from app.db import _factory
    from app.models import Appointment, RecordingPlan

    with _factory()() as db:  # time passes: turned on 3 days ago, the appointment was an hour ago
        pt_id = db.get(Appointment, appt["id"]).patient_id
        db.get(RecordingPlan, pt_id).periodic_since = datetime.now(UTC) - timedelta(days=3)
        db.get(Appointment, appt["id"]).at = datetime.now(UTC) - timedelta(hours=1)
        db.commit()
    plan = api.get(f"/hospital/patients/{ncid}/plan", headers=dr).json()
    assert plan["periodic"] is False and plan["periodic_until"] is None
    mine = api.get("/patient/plan", headers=ptok).json()
    assert mine["next_due"] is None and mine["due_now"] is False
    # Turned on again from the plan with no appointment booked: runs until one is booked.
    body = {"tests": ["FT"], "every_days": 3, "med_state": "OFF", "periodic": True}
    plan = api.put(f"/hospital/patients/{ncid}/plan", headers=dr, json=body).json()
    assert plan["periodic"] and plan["periodic_until"] is None
    soon = (datetime.now(UTC) + timedelta(days=4)).isoformat()
    api.post("/hospital/appointments", headers=desk, json={"ncid": ncid, "at": soon, "doctor_id": dr_id})
    assert (
        api.get(f"/hospital/patients/{ncid}/plan", headers=dr).json()["periodic_until"].startswith(soon[:16])
    )


def test_request_needs_a_joined_patient(api, two_hospitals):
    t = two_hospitals
    desk = _staff(api, t, "desk2@sunrise.example", "receptionist")
    inv = api.post("/hospital/patients/invite", headers=hdr(t["a_desk"]), json={"channel": "print"}).json()
    at = (datetime.now(UTC) + timedelta(days=2)).isoformat()
    appt = api.post("/hospital/appointments", headers=desk, json={"ncid": inv["ncid"], "at": at}).json()
    dr = _staff(api, t, "dr2@sunrise.example", "doctor")
    dr_id = next(
        d["id"]
        for d in api.get("/hospital/doctors", headers=desk).json()
        if d["email"] == "dr2@sunrise.example"
    )
    api.put(f"/hospital/appointments/{appt['id']}", headers=desk, json={"doctor_id": dr_id})
    r = api.post(f"/hospital/appointments/{appt['id']}/request", headers=dr, json={})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_joined"


def test_withdraw_keeps_history_and_recordings_and_rejoin(api, two_hospitals):
    t = two_hospitals
    ncid, acc = home_patient(api, t["a_desk"])
    ptok = hdr(acc["tokens"]["access_token"])
    sid = api.post("/sessions", headers=ptok, json=SESSION).json()["id"]
    take_id = _upload_take(api, acc["tokens"], sid, acc["server_key"], "tk-w")
    api.post(f"/takes/{take_id}/complete", headers=ptok)
    assert (
        api.post("/patient/consent/withdraw", headers=ptok, json={"delete_recordings": False}).status_code
        == 200
    )
    hist = api.get(f"/hospital/patients/{ncid}/history", headers=hdr(t["a_desk"])).json()
    assert (
        hist["app_status"] == "closed" and hist["withdrawn_at"] and hist["sessions"][0]["takes_uploaded"] == 1
    )

    # Everything stays with the hospital: no deletion after a withdrawal.
    from app.db import _factory
    from app.models import Take

    with _factory()() as db:
        assert db.get(Take, take_id) is not None

    # Joining again: a fresh invite for the same NCID; the history stays.
    r = api.post(f"/hospital/patients/{ncid}/reinvite", headers=hdr(t["a_desk"]), json={"channel": "print"})
    assert r.status_code == 200, r.text
    again = accept_patient(api, r.json()["invite_link"])
    assert again["ncid"] == ncid
    hist = api.get(f"/hospital/patients/{ncid}/history", headers=hdr(t["a_desk"])).json()
    assert hist["app_status"] == "active" and hist["withdrawn_at"] is None and len(hist["sessions"]) == 1
    assert api.get("/hospital/settings", headers=hdr(t["a_tok"])).status_code == 404


def test_joining_needs_no_consent(api, two_hospitals):
    inv = api.post(
        "/hospital/patients/invite", headers=hdr(two_hospitals["a_desk"]), json={"channel": "print"}
    ).json()
    r = api.post(
        "/patient/invite/accept",
        json={
            "token": inv["invite_link"].split("t=", 1)[1],
            "pin": "2580",
            "model": "m",
            "os_version": "1",
            "camera_check": {"effective_fps": 60},
        },
    )
    assert r.status_code == 201, r.text


def test_each_appointment_keeps_its_doctor(api, two_hospitals):
    """Decision 038 (user, 16 Nov 2026): Ravi sees Dr. Rao on one day and Dr. Iyer on another.
    Booking with another doctor no longer moves the patient's other appointments; both doctors
    may open the patient (history, every recording); each sends links only for their own."""
    t = two_hospitals
    desk = _staff(api, t, "desk4@sunrise.example", "receptionist")
    rao = _staff(api, t, "rao4@sunrise.example", "doctor")
    iyer = _staff(api, t, "iyer4@sunrise.example", "doctor")
    mehta = _staff(api, t, "mehta4@sunrise.example", "doctor")
    docs = {d["email"]: d["id"] for d in api.get("/hospital/doctors", headers=desk).json()}
    ncid, _acc = home_patient(api, t["a_desk"])
    soon = lambda d: (datetime.now(UTC) + timedelta(days=d)).isoformat()  # noqa: E731
    a1 = api.post(
        "/hospital/appointments",
        headers=desk,
        json={"ncid": ncid, "at": soon(2), "doctor_id": docs["rao4@sunrise.example"]},
    ).json()
    a2 = api.post(
        "/hospital/appointments",
        headers=desk,
        json={"ncid": ncid, "at": soon(9), "doctor_id": docs["iyer4@sunrise.example"]},
    ).json()
    rows = {a["id"]: a for a in api.get("/hospital/appointments?days=30", headers=desk).json()}
    assert rows[a1["id"]]["doctor_id"] == docs["rao4@sunrise.example"]  # not moved
    assert rows[a2["id"]]["doctor_id"] == docs["iyer4@sunrise.example"]
    # The default window (7 days) does not show the 9-day one; the range picker does.
    assert a2["id"] not in {a["id"] for a in api.get("/hospital/appointments", headers=desk).json()}
    # Each doctor lists only their own appointments...
    assert [a["id"] for a in api.get("/hospital/appointments?days=30", headers=rao).json()] == [a1["id"]]
    assert [a["id"] for a in api.get("/hospital/appointments?days=30", headers=iyer).json()] == [a2["id"]]
    # ...but both may open the patient; a doctor with no appointment may not.
    for h in (rao, iyer):
        assert api.get(f"/hospital/patients/{ncid}/history", headers=h).status_code == 200
    assert api.get(f"/hospital/patients/{ncid}/history", headers=mehta).status_code == 404
    assert any(p["ncid"] == ncid for p in api.get("/hospital/patients", headers=iyer).json())
    assert not any(p["ncid"] == ncid for p in api.get("/hospital/patients", headers=mehta).json())
    # Links only for one's own appointment.
    r = api.post(f"/hospital/appointments/{a2['id']}/request", headers=rao, json={})
    assert r.status_code == 403 and r.json()["detail"]["code"] == "not_your_appointment"
    assert api.post(f"/hospital/appointments/{a2['id']}/request", headers=iyer, json={}).status_code == 201
    # Changing the doctor of one appointment changes only that one, logged with both names.
    api.put(
        f"/hospital/appointments/{a1['id']}", headers=desk, json={"doctor_id": docs["mehta4@sunrise.example"]}
    )
    rows = {a["id"]: a for a in api.get("/hospital/appointments?days=30", headers=desk).json()}
    assert rows[a1["id"]]["doctor_id"] == docs["mehta4@sunrise.example"]
    assert rows[a2["id"]]["doctor_id"] == docs["iyer4@sunrise.example"]
    log = api.get("/hospital/audit", headers=hdr(t["a_tok"])).json()
    ch = next(e for e in log if e["action"] == "appointment_doctor_changed")
    assert ch["details"]["previous_name"] == "rao4@sunrise.example"
    assert ch["details"]["doctor_name"] == "mehta4@sunrise.example"
    assert not any(e["action"] == "patient_reassigned" for e in log)
    # Dr. Rao sent nothing and has no appointment left: no access any more. Dr. Mehta now has.
    assert api.get(f"/hospital/patients/{ncid}/history", headers=rao).status_code == 404
    assert api.get(f"/hospital/patients/{ncid}/history", headers=mehta).status_code == 200
    # Past range.
    assert api.get("/hospital/appointments?past_days=30", headers=desk).status_code == 200


def test_hospital_admin_cannot_do_front_desk_work(api, two_hospitals):
    """Decision 031 (user, 16 Nov 2026): invites, appointments and assignments are the front desk's."""
    t = two_hospitals
    admin = hdr(t["a_tok"])
    ncid, _ = home_patient(api, t["a_desk"])
    at = (datetime.now(UTC) + timedelta(days=2)).isoformat()
    assert api.post("/hospital/patients/invite", headers=admin, json={"channel": "print"}).status_code == 403
    assert (
        api.post(f"/hospital/patients/{ncid}/reinvite", headers=admin, json={"channel": "print"}).status_code
        == 403
    )
    assert api.get("/hospital/appointments", headers=admin).status_code == 403
    assert api.post("/hospital/appointments", headers=admin, json={"ncid": ncid, "at": at}).status_code == 403
    assert api.get("/hospital/doctors", headers=admin).status_code == 403
    # The front desk can.
    desk = hdr(t["a_desk"])
    assert api.post("/hospital/appointments", headers=desk, json={"ncid": ncid, "at": at}).status_code == 201


def test_appointment_history_and_logs_name_the_person(api, two_hospitals):
    """User, 16 Nov 2026: who added, invited, assigned, reassigned and sent the link, by name."""
    t = two_hospitals
    desk = hdr(t["a_desk"])
    admin = hdr(t["a_tok"])
    for email, name in (("rao5@sunrise.example", "Dr. Rao"), ("iyer5@sunrise.example", "Dr. Iyer")):
        api.post(
            "/hospital/staff", headers=admin, json={"email": email, "role": "doctor", "display_name": name}
        )
    from test_tenancy import sign_up

    iyer = hdr(sign_up(api, "iyer5@sunrise.example")[0])
    docs = {d["email"]: d["id"] for d in api.get("/hospital/doctors", headers=desk).json()}
    ncid, _acc = home_patient(api, t["a_desk"])
    at = (datetime.now(UTC) + timedelta(days=3)).isoformat()
    appt = api.post(
        "/hospital/appointments",
        headers=desk,
        json={"ncid": ncid, "at": at, "doctor_id": docs["rao5@sunrise.example"]},
    ).json()
    api.put(
        f"/hospital/appointments/{appt['id']}",
        headers=desk,
        json={"doctor_id": docs["iyer5@sunrise.example"]},
    )
    assert (
        api.post(
            f"/hospital/appointments/{appt['id']}/request", headers=iyer, json={"tests": ["FT"]}
        ).status_code
        == 201
    )

    hist = api.get(f"/hospital/appointments/{appt['id']}/history", headers=desk).json()
    steps = [(e["action"], e["actor_role"]) for e in hist]
    assert ("appointment_added", "receptionist") in steps
    assert ("appointment_doctor_changed", "receptionist") in steps
    assert ("recording_requested", "doctor") in steps
    moved = next(e for e in hist if e["action"] == "appointment_doctor_changed")
    assert moved["details"]["previous_name"] == "Dr. Rao" and moved["details"]["doctor_name"] == "Dr. Iyer"
    assert moved["actor_email"] == "frontdesk@sunrise.example"
    sent = next(e for e in hist if e["action"] == "recording_requested")
    assert sent["actor_name"] == "Dr. Iyer" and sent["details"]["tests"] == ["FT"]
    row = next(a for a in api.get("/hospital/appointments", headers=desk).json() if a["id"] == appt["id"])
    assert row["booked_by_name"] and row["last_event"]["action"] == "recording_requested"
    # The admin's activity log names the person, and the patient by NCID only.
    log = api.get("/hospital/audit", headers=admin).json()
    inv = next(e for e in log if e["action"] == "patient_invited" or e["action"] == "patient_created")
    assert inv["actor_email"] == "frontdesk@sunrise.example" and inv["actor_role"] == "receptionist"
    assert any(e["target_ncid"] == ncid for e in log)
    # Operators carry a name too.
    op = api.post("/hospital/operators", headers=admin, json={"code": "OP-N1", "name": "Kavya R"}).json()
    assert op["name"] == "Kavya R"
    staff = api.get("/hospital/staff", headers=admin).json()
    assert any(s["last_login_at"] for s in staff)


def test_platform_admin_sets_permissions_per_hospital(api, two_hospitals):
    """Decision 033: defaults from config; a platform admin changes them for one hospital, with a
    reason, logged by name; fixed rules (clinical data) are not permissions."""
    t = two_hospitals
    root = hdr(t["platform"])
    desk = hdr(t["a_desk"])
    url = f"/platform/hospitals/{t['a']}/permissions"
    perms = api.get(url, headers=root).json()
    rows = {r["key"]: r for r in perms["rows"]}
    assert rows["appointments.add"]["roles"] == ["receptionist"] and not rows["appointments.add"]["changed"]
    assert "hospital_admin" in rows["setup.team"]["roles"]
    assert not any("clinical" in k or "history" in k for k in rows)  # fixed in code, not a setting
    me = api.get("/staff/me", headers=desk).json()
    assert "invites.send" in me["permissions"] and "setup.team" not in me["permissions"]

    # A small clinic: the doctor books and assigns; the front desk stops inviting.
    dr = _staff(api, t, "perm.dr@sunrise.example", "doctor")
    dr_id = next(
        d["id"]
        for d in api.get("/hospital/doctors", headers=desk).json()
        if d["email"] == "perm.dr@sunrise.example"
    )
    ncid, _ = home_patient(api, t["a_desk"])
    at = (datetime.now(UTC) + timedelta(days=2)).isoformat()
    body = {"ncid": ncid, "at": at, "doctor_id": dr_id}
    assert api.post("/hospital/appointments", headers=dr, json=body).status_code == 403
    assert (
        api.put(
            url, headers=root, json={"roles": {"requests.send": ["receptionist"]}, "reason": "x y z"}
        ).status_code
        == 422
    )
    new = {
        "appointments.add": ["receptionist", "doctor"],
        "appointments.assign": ["receptionist", "doctor"],
        "invites.send": [],
    }
    r = api.put(url, headers=root, json={"roles": new, "reason": "Small clinic: Dr books"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["reason"] == "Small clinic: Dr books" and out["changed_by_name"]
    assert {x["key"] for x in out["rows"] if x["changed"]} == set(new)
    assert api.post("/hospital/appointments", headers=dr, json=body).status_code == 201
    assert api.post("/hospital/patients/invite", headers=desk, json={"channel": "print"}).status_code == 403
    # The other hospital keeps the defaults.
    b_rows = api.get(f"/platform/hospitals/{t['b']}/permissions", headers=root).json()["rows"]
    assert not any(x["changed"] for x in b_rows)
    # The hospital admin sees it, read only; the change is in both logs, by name.
    assert (
        api.get("/hospital/permissions", headers=hdr(t["a_tok"])).json()["reason"] == "Small clinic: Dr books"
    )
    assert api.put(url, headers=hdr(t["a_tok"]), json={"roles": {}, "reason": "nope"}).status_code == 403
    log = api.get("/hospital/audit", headers=hdr(t["a_tok"])).json()
    ev = next(e for e in log if e["action"] == "permissions_changed")
    assert ev["actor_role"] == "platform_admin" and ev["details"]["reason"] == "Small clinic: Dr books"
    # Reset to defaults.
    api.put(url, headers=root, json={"roles": {}, "reason": "Back to defaults"})
    assert api.post("/hospital/patients/invite", headers=desk, json={"channel": "print"}).status_code == 201


def test_hospital_can_switch_off_clinic_recording(api, two_hospitals):
    from test_tenancy import register_phone

    t = two_hospitals
    dev = register_phone(api, t["a_tok"])
    op = api.post("/hospital/operators", headers=hdr(t["a_tok"]), json={"code": "OP-P1"}).json()
    login = {
        "device_id": dev["device_id"],
        "device_secret": dev["device_secret"],
        "operator_code": "OP-P1",
        "password": op["temporary_password"],
    }
    assert api.post("/auth/login", json=login).status_code == 200
    url = f"/platform/hospitals/{t['a']}/permissions"
    api.put(url, headers=hdr(t["platform"]), json={"roles": {"clinic.record": []}, "reason": "Home only"})
    r = api.post("/auth/login", json=login)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "not_permitted"


def test_home_and_clinic_requests_and_the_clinic_queue(api, two_hospitals):
    """User, 16 Nov 2026: the doctor chooses home, clinic or both; clinic requests appear in the
    clinic phones' queue for the visit day; the operator records or marks "not recorded"."""
    from test_tenancy import register_phone

    t = two_hospitals
    desk = hdr(t["a_desk"])
    dr = _staff(api, t, "where.dr@sunrise.example", "doctor")
    dr_id = next(
        d["id"]
        for d in api.get("/hospital/doctors", headers=desk).json()
        if d["email"] == "where.dr@sunrise.example"
    )
    joined, acc = home_patient(api, t["a_desk"])
    # A patient with an NCID who has not joined the app (clinic patient).
    inv = api.post("/hospital/patients/invite", headers=desk, json={"channel": "print"}).json()
    walkin = inv["ncid"]
    visit = (datetime.now(UTC) + timedelta(hours=3)).replace(microsecond=0)
    a1 = api.post(
        "/hospital/appointments",
        headers=desk,
        json={"ncid": joined, "at": visit.isoformat(), "doctor_id": dr_id},
    ).json()
    a2 = api.post(
        "/hospital/appointments",
        headers=desk,
        json={"ncid": walkin, "at": visit.isoformat(), "doctor_id": dr_id},
    ).json()

    both = api.post(
        f"/hospital/appointments/{a1['id']}/request",
        headers=dr,
        json={"places": ["clinic", "home"], "tests": ["FT"]},
    )
    assert both.status_code == 201, both.text
    assert [r["place"] for r in both.json()] == ["home", "clinic"]
    # Home needs the app; clinic does not.
    no = api.post(f"/hospital/appointments/{a2['id']}/request", headers=dr, json={"places": ["home"]})
    assert no.status_code == 409 and no.json()["detail"]["code"] == "not_joined"
    ok = api.post(f"/hospital/appointments/{a2['id']}/request", headers=dr, json={"places": ["clinic"]})
    assert ok.status_code == 201 and ok.json()[0]["place"] == "clinic"
    # The patient's app shows the clinic request as information only.
    mine = api.get("/patient/requests", headers=hdr(acc["tokens"]["access_token"])).json()
    assert sorted(m["place"] for m in mine) == ["clinic", "home"]

    # The clinic phone's queue for today: both clinic requests, by NCID (names come from the connector).
    dev = register_phone(api, t["a_tok"])
    op = api.post(
        "/hospital/operators", headers=hdr(t["a_tok"]), json={"code": "OP-Q", "name": "Kavya R"}
    ).json()
    login = {
        "device_id": dev["device_id"],
        "device_secret": dev["device_secret"],
        "operator_code": "OP-Q",
        "password": op["temporary_password"],
    }
    otok = hdr(api.post("/auth/login", json=login).json()["access_token"])
    day = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    win = {"from": (day - timedelta(hours=12)).isoformat(), "to": (day + timedelta(hours=36)).isoformat()}
    q = api.get("/clinic/queue", headers=otok, params=win)
    assert q.status_code == 200, q.text
    assert {i["ncid"] for i in q.json()} == {joined, walkin} and all(i["state"] == "open" for i in q.json())
    assert api.get("/clinic/queue", headers=desk, params=win).status_code == 403  # clinic phones only
    too_long = {"from": win["from"], "to": (day + timedelta(days=5)).isoformat()}
    assert api.get("/clinic/queue", headers=otok, params=too_long).status_code == 422

    # Not recorded, with a reason from the config list; logged by name.
    rid = next(i["request_id"] for i in q.json() if i["ncid"] == walkin)
    assert (
        api.post(f"/clinic/requests/{rid}/not-done", headers=otok, json={"reason": "bored"}).status_code
        == 422
    )
    nd = api.post(f"/clinic/requests/{rid}/not-done", headers=otok, json={"reason": "did_not_attend"}).json()
    assert nd["state"] == "not_recorded" and nd["recorded_by"] == "Kavya R (OP-Q)"
    stages = {a["id"]: a["stage"] for a in api.get("/hospital/appointments", headers=desk).json()}
    assert stages[a2["id"]] == "not_recorded" and stages[a1["id"]] == "sent"
    hist = api.get(f"/hospital/appointments/{a2['id']}/history", headers=desk).json()
    assert any(e["action"] == "clinic_not_recorded" and e["actor_name"] == "Kavya R (OP-Q)" for e in hist)
    # Reminders go out for home links only.
    from app.db import _factory
    from app.models import RecordingRequest

    with _factory()() as db:
        assert all(
            not r.remind
            for r in db.scalars(select(RecordingRequest).where(RecordingRequest.place == "clinic"))
        )


def test_camera_check_before_a_phone_is_added(api, two_hospitals):
    """User, 16 Nov 2026: 55 fps or more, for clinic phones and patients; a failed check does not
    use up the code or the invite; a patient whose phone fails can tell the hospital."""
    t = two_hospitals
    admin = hdr(t["a_tok"])
    code = api.post("/hospital/device-codes", headers=admin, json={"label": "Ward 5"}).json()["code"]
    reg = {"enrollment_code": code, "model": "Galaxy A12", "os_version": "13"}
    r = api.post("/auth/device-register", json=reg)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "camera_check_required"
    r = api.post("/auth/device-register", json={**reg, "camera_check": {"effective_fps": 48}})
    assert r.status_code == 422 and r.json()["detail"] == {
        "code": "camera_check_failed",
        "min_fps": 55.0,
        "fps": 48.0,
    }
    # The code still works on another phone; 55 is enough.
    ok = api.post(
        "/auth/device-register", json={**reg, "model": "Pixel 8", "camera_check": {"effective_fps": 55}}
    )
    assert ok.status_code == 201, ok.text
    devs = {d["id"]: d for d in api.get("/hospital/devices", headers=admin).json()}
    assert devs[ok.json()["device_id"]]["check_fps"] == 55.0

    # Patients: same minimum; "Tell my hospital" leaves the invite valid.
    inv = api.post("/hospital/patients/invite", headers=hdr(t["a_desk"]), json={"channel": "print"}).json()
    tok = inv["invite_link"].split("t=", 1)[1]
    join = {"token": tok, "pin": "2580", "model": "m", "os_version": "1"}
    bad = api.post("/patient/invite/accept", json={**join, "camera_check": {"effective_fps": 41}})
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "camera_check_failed"
    told = api.post(
        "/patient/invite/phone-not-suitable",
        json={"token": tok, "model": "old phone", "camera_check": {"effective_fps": 41}},
    )
    assert told.status_code == 204
    rows = {p["ncid"]: p for p in api.get("/hospital/patients", headers=hdr(t["a_desk"])).json()}
    assert rows[inv["ncid"]]["phone_unsuitable_fps"] == 41.0 and rows[inv["ncid"]]["status"] == "invited"
    log = api.get("/hospital/audit", headers=admin).json()
    assert any(e["action"] == "phone_not_suitable" and e["details"]["fps"] == 41.0 for e in log)
    # A family member's phone passes: joins with the same invite; the warning clears.
    good = api.post("/patient/invite/accept", json={**join, "camera_check": {"effective_fps": 59.6}})
    assert good.status_code == 201, good.text
    rows = {p["ncid"]: p for p in api.get("/hospital/patients", headers=hdr(t["a_desk"])).json()}
    assert rows[inv["ncid"]]["phone_unsuitable_fps"] is None and rows[inv["ncid"]]["status"] == "active"


def test_times_keep_their_zone_and_log_names_doctors(api, two_hospitals):
    """User, 16 Nov 2026: an appointment booked for 21 Nov 00:42 in India showed as 20 Nov 7:12 pm
    (SQLite dropped the zone), and "Reassigned: {{previous_name}} → {{doctor_name}}" in the log."""
    from datetime import datetime, timedelta, timezone

    t = two_hospitals
    desk = hdr(t["a_desk"])
    _staff(api, t, "rao@sunrise.example", "doctor")
    _staff(api, t, "iyer@sunrise.example", "doctor")
    docs = {d["email"]: d["id"] for d in api.get("/hospital/doctors", headers=desk).json()}
    ncid = api.post("/hospital/patients/invite", headers=desk, json={"channel": "print"}).json()["ncid"]
    ist = timezone(timedelta(hours=5, minutes=30))
    at = (datetime.now(ist) + timedelta(days=2)).replace(hour=0, minute=42, second=0, microsecond=0)
    r = api.post(
        "/hospital/appointments",
        headers=desk,
        json={"ncid": ncid, "at": at.isoformat(), "doctor_id": docs["rao@sunrise.example"]},
    )
    assert r.status_code == 201, r.text
    listed = next(a for a in api.get("/hospital/appointments", headers=desk).json() if a["ncid"] == ncid)
    sent = datetime.fromisoformat(listed["at"].replace("Z", "+00:00"))
    assert sent.tzinfo is not None and sent == at  # same instant, with its zone

    api.put(
        f"/hospital/appointments/{r.json()['id']}",
        headers=desk,
        json={"doctor_id": docs["iyer@sunrise.example"]},
    )
    log = api.get("/hospital/audit", headers=hdr(t["a_tok"])).json()
    moved = next(e for e in log if e["action"] == "appointment_doctor_changed")
    assert moved["details"]["previous_name"] in ("rao@sunrise.example", "Rao")
    assert moved["details"]["doctor_name"] in ("iyer@sunrise.example", "Iyer")
    assert moved["at"].endswith(("Z", "+00:00"))
