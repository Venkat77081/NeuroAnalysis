"""M14: on the connector a doctor sees only assigned patients (checked with the platform on every
request); a receptionist finds patients and assigns them but sees no history or recordings."""

from test_e2e import accept, ctoken
from test_readiness_api import _upload_take
from test_tenancy import SESSION, hdr, sign_up, staff_login


def test_doctor_access_follows_assignment(connector):
    env, c, api = connector, connector["client"], connector["platform"]
    admin = ctoken(env)
    inv = c.post("/v1/invites", headers=admin, json={"mrns": ["00012388"], "channel": "print"}).json()[0]
    acc = accept(env, inv["invite_link"])
    sid = api.post("/sessions", headers=hdr(acc["tokens"]["access_token"]), json=SESSION).json()["id"]
    take_id = _upload_take(api, acc["tokens"], sid, acc["server_key"], "tk-as")
    api.post(f"/takes/{take_id}/complete", headers=hdr(acc["tokens"]["access_token"]))
    ncid = inv["ncid"]

    toks = {}
    for email, role in (
        ("desk@sunrise.example", "receptionist"),
        ("dr1@sunrise.example", "doctor"),
        ("dr2@sunrise.example", "doctor"),
    ):
        api.post("/hospital/staff", headers=hdr(env["admin_tok"]), json={"email": email, "role": role})
        _, secret = sign_up(api, email)
        toks[email] = staff_login(api, email, secret)["access_token"]
    desk = ctoken(env, toks["desk@sunrise.example"])
    dr1 = ctoken(env, toks["dr1@sunrise.example"])
    dr2 = ctoken(env, toks["dr2@sunrise.example"])

    # Receptionist: finds patients by name, sees names for NCIDs, creates NCIDs; no history or videos.
    assert c.get("/v1/patients", params={"q": "ravi"}, headers=desk).json()[0]["name"] == "Ravi Samplename"
    assert (
        c.post("/v1/patients/lookup", headers=desk, json={"ncids": [ncid]}).json()[0]["name"]
        == "Asha Testpatient"
    )
    assert c.post("/v1/ncid", headers=desk, json={"mrn": "00012401"}).status_code == 200
    assert c.get(f"/v1/patients/{ncid}", headers=desk).status_code == 403
    assert c.get(f"/v1/takes/{take_id}/files/video", headers=desk).status_code == 403
    # v3: reception sends join invites.
    assert (
        c.post("/v1/invites", headers=desk, json={"mrns": ["00012388"], "channel": "print"}).status_code
        == 200
    )
    # Doctors cannot search the hospital's records; unassigned patients are invisible.
    assert c.get("/v1/patients", params={"q": "asha"}, headers=dr1).status_code == 403
    assert c.post("/v1/patients/lookup", headers=dr1, json={"ncids": [ncid]}).json() == []
    for path in (
        f"/v1/patients/{ncid}",
        f"/v1/patients/{ncid}/recordings",
        f"/v1/patients/{ncid}/reviews",
        f"/v1/takes/{take_id}/files/video",
    ):
        assert c.get(path, headers=dr1).status_code == 404, path

    docs = {
        d["email"]: d["id"]
        for d in api.get("/hospital/doctors", headers=hdr(toks["desk@sunrise.example"])).json()
    }
    api.put(
        f"/hospital/patients/{ncid}/doctor",
        headers=hdr(toks["desk@sunrise.example"]),
        json={"doctor_id": docs["dr1@sunrise.example"]},
    )
    assert c.get(f"/v1/patients/{ncid}", headers=dr1).json()["name"] == "Asha Testpatient"
    assert c.get(f"/v1/takes/{take_id}/files/video", headers=dr1).status_code == 200
    assert c.post("/v1/patients/lookup", headers=dr1, json={"ncids": [ncid]}).json()[0]["mrn"] == "00012388"
    assert c.get(f"/v1/patients/{ncid}", headers=dr2).status_code == 404

    # Reassign: takes effect on the very next request.
    api.put(
        f"/hospital/patients/{ncid}/doctor",
        headers=hdr(toks["desk@sunrise.example"]),
        json={"doctor_id": docs["dr2@sunrise.example"]},
    )
    assert c.get(f"/v1/patients/{ncid}", headers=dr1).status_code == 404
    assert c.post(f"/v1/takes/{take_id}/review", headers=dr1, json={"usable": True}).status_code == 404
    assert c.get(f"/v1/patients/{ncid}", headers=dr2).status_code == 200
    assert c.post(f"/v1/takes/{take_id}/review", headers=dr2, json={"usable": True}).status_code == 201
