"""M13 backend: recording plans, the patient's own history, consent withdrawal and deletion."""

from datetime import UTC, datetime, timedelta

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


def test_plan_default_set_and_due(api, two_hospitals):
    t = two_hospitals
    ncid, acc = home_patient(api, t["a_tok"])
    ptok = hdr(acc["tokens"]["access_token"])
    plan = api.get("/patient/plan", headers=ptok).json()
    assert plan["default"] and plan["tests"] == ["FT", "FTF", "FR", "SAW", "FA"] and plan["every_days"] == 7
    assert plan["med_state"] == "OFF" and plan["due_now"] and plan["next_due"] is None

    body = {"tests": ["FT", "FA", "FT"], "every_days": 3, "med_state": "ON"}
    r = api.put(f"/hospital/patients/{ncid}/plan", headers=hdr(t["a_tok"]), json=body)
    assert r.status_code == 200 and r.json()["tests"] == ["FT", "FA"] and not r.json()["default"]
    assert (
        api.put(
            f"/hospital/patients/{ncid}/plan", headers=hdr(t["a_tok"]), json={**body, "note": "free text"}
        ).status_code
        == 422
    )  # no free text
    # Another hospital cannot see or set it; the patient cannot set it.
    assert api.get(f"/hospital/patients/{ncid}/plan", headers=hdr(t["b_tok"])).status_code == 404
    assert api.put(f"/hospital/patients/{ncid}/plan", headers=hdr(t["b_tok"]), json=body).status_code == 404
    assert api.put(f"/hospital/patients/{ncid}/plan", headers=ptok, json=body).status_code == 403

    started = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    s = api.post("/sessions", headers=ptok, json={**SESSION, "started_at": started})
    assert s.status_code == 201
    plan = api.get("/patient/plan", headers=ptok).json()
    assert plan["tests"] == ["FT", "FA"] and plan["med_state"] == "ON"
    assert not plan["due_now"] and plan["next_due"].startswith(
        (datetime.now(UTC) + timedelta(days=2)).date().isoformat()
    )


def test_patient_history_and_withdraw_with_deletion(api, two_hospitals):
    t = two_hospitals
    ncid, acc = home_patient(api, t["a_tok"])
    _, other = home_patient(api, t["a_tok"])
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
    _, acc = home_patient(api, two_hospitals["a_tok"])
    r = api.post(
        "/patient/consent/withdraw",
        headers=hdr(acc["tokens"]["access_token"]),
        json={"delete_recordings": False},
    )
    assert r.json() == {"status": "closed", "deletion_request_id": None}


def test_operator_needs_ncid_without_legacy_hash(api, two_hospitals, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "allow_legacy_ref_hash", False)
    _, acc = home_patient(api, two_hospitals["a_tok"])
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
