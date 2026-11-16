"""M13: a clinic phone gets a patient's NCID from the hospital connector by MRN (operator token),
and records by NCID. The operator token allows nothing else on the connector."""

from test_tenancy import SESSION, hdr, register_phone


def test_operator_ncid_lookup_then_clinic_session(connector, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "allow_legacy_ref_hash", False)
    api, c = connector["platform"], connector["client"]
    dev = register_phone(api, connector["admin_tok"])
    op = api.post("/hospital/operators", headers=hdr(connector["admin_tok"]), json={"code": "OP-1"}).json()
    creds = {"device_id": dev["device_id"], "device_secret": dev["device_secret"], "operator_code": "OP-1"}
    tok = api.post("/auth/login", json={**creds, "password": op["temporary_password"]}).json()["access_token"]
    # Must change the temporary password first.
    assert api.post("/auth/connector-token", headers=hdr(tok)).status_code == 403
    api.post(
        "/auth/change-password",
        headers=hdr(tok),
        json={"current_password": op["temporary_password"], "new_password": "clinic-phone-77"},
    )
    tok = api.post("/auth/login", json={**creds, "password": "clinic-phone-77"}).json()["access_token"]
    ct = api.post("/auth/connector-token", headers=hdr(tok))
    assert ct.status_code == 200 and ct.json()["connector_url"] == "http://connector.test"
    otok = hdr(ct.json()["token"])

    r = c.post("/v1/ncid", headers=otok, json={"mrn": "00012388"})
    assert r.status_code == 200, r.text
    ncid = r.json()["ncid"]
    assert c.post("/v1/ncid", headers=otok, json={"mrn": "00012388"}).json()["ncid"] == ncid
    # Nothing else: no record search, no history, no invites, no recordings.
    assert c.get("/v1/patients", params={"q": "asha"}, headers=otok).status_code == 403
    assert c.get(f"/v1/patients/{ncid}", headers=otok).status_code == 403
    assert c.post("/v1/invites", headers=otok, json={"mrns": ["00012388"]}).status_code == 403
    assert c.get(f"/v1/patients/{ncid}/recordings", headers=otok).status_code == 403
    # Names only for patients in the clinic queue: none yet.
    assert c.post("/v1/patients/lookup", headers=otok, json={"ncids": [ncid]}).json() == []

    s = api.post(
        "/sessions", headers=hdr(tok), json={**SESSION, "client_session_id": "c-1", "patient": {"ncid": ncid}}
    )
    assert s.status_code == 201, s.text
    # A doctor puts the patient in the clinic queue: now the phone may show the name.
    from datetime import UTC, datetime, timedelta

    from test_e2e import doctor_for

    doctor_for(connector, ncid, email="queue.dr@sunrise.example")
    desk = hdr(connector["desk_tok"])
    docs = {d["email"]: d["id"] for d in api.get("/hospital/doctors", headers=desk).json()}
    at = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
    appt = api.post(
        "/hospital/appointments",
        headers=desk,
        json={"ncid": ncid, "at": at, "doctor_id": docs["queue.dr@sunrise.example"]},
    ).json()
    from test_tenancy import staff_login

    dr_tok = staff_login(api, "queue.dr@sunrise.example", connector["readers"]["queue.dr@sunrise.example"])
    r = api.post(
        f"/hospital/appointments/{appt['id']}/request",
        headers=hdr(dr_tok["access_token"]),
        json={"places": ["clinic"]},
    )
    assert r.status_code == 201, r.text
    names = c.post("/v1/patients/lookup", headers=otok, json={"ncids": [ncid]}).json()
    assert names[0]["mrn"] == "00012388" and names[0]["name"] == "Asha Testpatient"
    # The platform never saw the MRN.
    from test_e2e import platform_dump

    assert "00012388" not in platform_dump(connector)
