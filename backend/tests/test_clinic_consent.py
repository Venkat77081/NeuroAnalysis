"""v16 (decision 047): consent for clinic recordings: the patient agrees in the app and shows a
one-time QR; the clinic phone scans it before recording; fallback on the clinic phone."""

from datetime import UTC, datetime, timedelta

from test_patient_app import _staff, home_patient
from test_tenancy import (  # noqa: F401 - fixtures
    SESSION,
    _clean,
    hdr,
    platform,
    register_phone,
    two_hospitals,
)


def _setup(api, t):
    desk = _staff(api, t, "cc-desk@sunrise.example", "receptionist")
    dr = _staff(api, t, "cc-dr@sunrise.example", "doctor")
    dr_id = next(
        d["id"]
        for d in api.get("/hospital/doctors", headers=desk).json()
        if d["email"] == "cc-dr@sunrise.example"
    )
    ncid, acc = home_patient(api, t["a_desk"])
    walkin = api.post(
        "/hospital/patients/invite", headers=hdr(t["a_desk"]), json={"channel": "print"}
    ).json()["ncid"]
    visit = (datetime.now(UTC) + timedelta(hours=2)).replace(microsecond=0)
    reqs = {}
    for who in (ncid, walkin):
        a = api.post(
            "/hospital/appointments",
            headers=desk,
            json={"ncid": who, "at": visit.isoformat(), "doctor_id": dr_id},
        ).json()
        r = api.post(f"/hospital/appointments/{a['id']}/request", headers=dr, json={"places": ["clinic"]})
        assert r.status_code == 201, r.text
        reqs[who] = r.json()[0]["id"]
    dev = register_phone(api, t["a_tok"])
    op = api.post(
        "/hospital/operators", headers=hdr(t["a_tok"]), json={"code": "OP-C", "name": "Kavya R"}
    ).json()
    login = {
        "device_id": dev["device_id"],
        "device_secret": dev["device_secret"],
        "operator_code": "OP-C",
        "password": op["temporary_password"],
    }
    first = api.post("/auth/login", json=login).json()["access_token"]
    api.post(
        "/auth/change-password",
        headers=hdr(first),
        json={"current_password": op["temporary_password"], "new_password": "clinic-phone-77"},
    )
    otok = hdr(api.post("/auth/login", json={**login, "password": "clinic-phone-77"}).json()["access_token"])
    return ncid, walkin, reqs, hdr(acc["tokens"]["access_token"]), otok


def _queue(api, otok):
    day = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    win = {"from": (day - timedelta(hours=12)).isoformat(), "to": (day + timedelta(hours=36)).isoformat()}
    return {q["ncid"]: q for q in api.get("/clinic/queue", headers=otok, params=win).json()}


def _session(api, otok, ncid, req_id, consent_id=None, cid="c1"):
    body = {
        **SESSION,
        "client_session_id": cid,
        "patient": {"ncid": ncid},
        "request_id": req_id,
        **({"consent_id": consent_id} if consent_id else {}),
    }
    return api.post("/sessions", headers=otok, json=body)


def test_qr_consent_scanned_before_recording(api, two_hospitals):
    t = two_hospitals
    ncid, walkin, reqs, ptok, otok = _setup(api, t)
    q = _queue(api, otok)
    assert q[ncid]["consent"] == {"state": "waiting", "phone_allowed": True}
    assert q[walkin]["consent"]["state"] == "no_app"

    # No consent: the clinic phone cannot start the session.
    r = _session(api, otok, ncid, reqs[ncid])
    assert r.status_code == 422 and r.json()["detail"] == {"code": "clinic_consent_required"}

    # The patient agrees in the app: a one-time code (QR), valid until the end of the visit day.
    bad = api.post(
        f"/patient/requests/{reqs[ncid]}/clinic-consent", headers=ptok, json={"consent_version": "x@1"}
    )
    assert bad.status_code == 422
    r = api.post(
        f"/patient/requests/{reqs[ncid]}/clinic-consent",
        headers=ptok,
        json={"consent_version": "home-consent@1"},
    )
    assert r.status_code == 201, r.text
    c = r.json()
    assert c["qr"] == f"ncc1:{c['code']}" and len(c["code"]) == 12
    assert datetime.fromisoformat(c["valid_until"]) > datetime.now(UTC)
    mine = {m["id"]: m for m in api.get("/patient/requests", headers=ptok).json()}
    assert mine[reqs[ncid]]["clinic_consent"]["status"] == "active"
    assert _queue(api, otok)[ncid]["consent"]["state"] == "app_given"
    # Another patient's request cannot be answered by this patient.
    assert (
        api.post(
            f"/patient/requests/{reqs[walkin]}/clinic-consent",
            headers=ptok,
            json={"consent_version": "home-consent@1"},
        ).status_code
        == 404
    )

    # Scanning: for the wrong request it is refused; typed with dashes it works; once only.
    wrong = api.post(f"/clinic/requests/{reqs[walkin]}/consent-scan", headers=otok, json={"code": c["qr"]})
    assert wrong.json()["detail"] == {"code": "wrong_patient"}
    junk = api.post(
        f"/clinic/requests/{reqs[ncid]}/consent-scan", headers=otok, json={"code": "ncc1:ZZZZZZZZZZZZ"}
    )
    assert junk.json()["detail"] == {"code": "consent_unknown"}
    typed = "-".join(c["code"][i : i + 4] for i in range(0, 12, 4)).lower()
    ok = api.post(f"/clinic/requests/{reqs[ncid]}/consent-scan", headers=otok, json={"code": typed})
    assert ok.status_code == 200, ok.text
    conf = ok.json()
    assert conf["source"] == "patient_app" and conf["consent_version"] == "home-consent@1"
    again = api.post(f"/clinic/requests/{reqs[ncid]}/consent-scan", headers=otok, json={"code": c["qr"]})
    assert again.json()["detail"] == {"code": "consent_used"}

    # The session carries it; the same consent cannot start a second session.
    s = _session(api, otok, ncid, reqs[ncid], conf["consent_id"])
    assert s.status_code == 201, s.text
    assert _session(api, otok, ncid, reqs[ncid], conf["consent_id"], cid="c2").status_code == 422
    hist = api.get(f"/hospital/patients/{ncid}/history", headers=hdr(t["a_desk"]))
    if hist.status_code == 200:
        assert hist.json()["sessions"][0]["consent_source"] == "patient_app"

    # Patients' own sessions need none of this.
    assert (
        api.post("/sessions", headers=ptok, json={**SESSION, "client_session_id": "home"}).status_code == 201
    )


def test_withdraw_expire_and_phone_fallback(api, two_hospitals):
    t = two_hospitals
    ncid, walkin, reqs, ptok, otok = _setup(api, t)
    body = {"consent_version": "home-consent@1"}
    c = api.post(f"/patient/requests/{reqs[ncid]}/clinic-consent", headers=ptok, json=body).json()
    assert (
        api.post(f"/patient/requests/{reqs[ncid]}/clinic-consent/withdraw", headers=ptok).status_code == 204
    )
    r = api.post(f"/clinic/requests/{reqs[ncid]}/consent-scan", headers=otok, json={"code": c["qr"]})
    assert r.json()["detail"] == {"code": "consent_withdrawn"}
    assert _queue(api, otok)[ncid]["consent"]["state"] == "waiting"

    # Expired (past the visit day).
    c = api.post(f"/patient/requests/{reqs[ncid]}/clinic-consent", headers=ptok, json=body).json()
    from app.db import _factory
    from app.models import ClinicConsent

    with _factory()() as db:
        for x in db.query(ClinicConsent).filter(ClinicConsent.status == "active"):
            x.valid_until = datetime.now(UTC) - timedelta(minutes=1)
        db.commit()
    r = api.post(f"/clinic/requests/{reqs[ncid]}/consent-scan", headers=otok, json={"code": c["qr"]})
    assert r.json()["detail"] == {"code": "consent_expired"}

    # No app: consent on the clinic phone, with a reason from the list.
    bad = api.post(
        f"/clinic/requests/{reqs[walkin]}/consent-on-phone",
        headers=otok,
        json={"reason": "lazy", "consent_version": "home-consent@1"},
    )
    assert bad.status_code == 422
    r = api.post(
        f"/clinic/requests/{reqs[walkin]}/consent-on-phone",
        headers=otok,
        json={"reason": "no_smartphone", "consent_version": "home-consent@1"},
    )
    assert (
        r.status_code == 200
        and r.json()["source"] == "clinic_phone"
        and r.json()["reason"] == "no_smartphone"
    )
    assert _session(api, otok, walkin, reqs[walkin], r.json()["consent_id"]).status_code == 201

    # The hospital turns the fallback off.
    api.put("/hospital/settings", headers=hdr(t["a_tok"]), json={"clinic_phone_consent": False})
    assert _queue(api, otok)[ncid]["consent"]["phone_allowed"] is False
    r = api.post(
        f"/clinic/requests/{reqs[ncid]}/consent-on-phone",
        headers=otok,
        json={"reason": "phone_not_with_them", "consent_version": "home-consent@1"},
    )
    assert r.json()["detail"] == {"code": "phone_consent_off"}
