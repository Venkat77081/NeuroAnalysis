"""Decision 040: visit remarks, one per appointment, written by its own doctor and kept at the
hospital; every doctor who may open the patient reads them; the platform never sees the text."""

from datetime import UTC, datetime, timedelta

from test_e2e import accept, ctoken, platform_dump
from test_tenancy import hdr, sign_up, staff_login


def _doctor(env, email):
    env["platform"].post("/hospital/staff", headers=hdr(env["admin_tok"]), json={"email": email})
    _, secret = sign_up(env["platform"], email)
    return staff_login(env["platform"], email, secret)["access_token"]


def test_visit_remarks(connector):
    env, c, api = connector, connector["client"], connector["platform"]
    inv = c.post("/v1/invites", headers=ctoken(env), json={"mrns": ["00012388"], "channel": "print"}).json()[
        0
    ]
    accept(env, inv["invite_link"])
    ncid = inv["ncid"]
    rao, iyer, mehta = (_doctor(env, e) for e in ("rao@s.example", "iyer@s.example", "mehta@s.example"))
    desk = hdr(env["desk_tok"])
    docs = {d["email"]: d["id"] for d in api.get("/hospital/doctors", headers=desk).json()}

    def book(email, days):
        at = (datetime.now(UTC) + timedelta(days=days)).isoformat()
        r = api.post(
            "/hospital/appointments", headers=desk, json={"ncid": ncid, "at": at, "doctor_id": docs[email]}
        )
        return r.json()["id"]

    a_rao, a_iyer = book("rao@s.example", 1), book("iyer@s.example", 8)
    text = "Tremor at rest improved since the dose change. Asha to continue; review in 4 weeks."
    r = c.put(f"/v1/appointments/{a_rao}/remark", headers=ctoken(env, rao), json={"text": text})
    assert r.status_code == 200 and r.json()["text"] == text
    # Dr. Iyer (his own upcoming appointment) reads it, but cannot write on Dr. Rao's appointment.
    got = c.get(f"/v1/patients/{ncid}/remarks", headers=ctoken(env, iyer)).json()
    assert [(x["appointment_id"], x["text"]) for x in got] == [(a_rao, text)]
    no = c.put(f"/v1/appointments/{a_rao}/remark", headers=ctoken(env, iyer), json={"text": "x"})
    assert no.status_code == 403 and no.json()["detail"]["code"] == "not_your_appointment"
    assert (
        c.put(f"/v1/appointments/{a_iyer}/remark", headers=ctoken(env, iyer), json={"text": "OK"}).status_code
        == 200
    )
    # A doctor with no appointment with Asha sees nothing; front desk and admin never.
    assert c.get(f"/v1/patients/{ncid}/remarks", headers=ctoken(env, mehta)).status_code == 404
    assert c.get(f"/v1/patients/{ncid}/remarks", headers=ctoken(env)).status_code == 403
    # Editing replaces; an empty text clears.
    c.put(f"/v1/appointments/{a_rao}/remark", headers=ctoken(env, rao), json={"text": text + " Edited."})
    assert (
        c.put(f"/v1/appointments/{a_iyer}/remark", headers=ctoken(env, iyer), json={"text": "  "}).json()
        is None
    )
    got = c.get(f"/v1/patients/{ncid}/remarks", headers=ctoken(env, rao)).json()
    assert [x["text"] for x in got] == [text + " Edited."]
    actions = [e["action"] for e in c.get("/v1/activity", headers=ctoken(env, env["admin_tok"])).json()]
    assert "visit_remark_written" in actions and "visit_remark_cleared" in actions
    # The text (with the patient's name) never reached the platform.
    assert "Tremor at rest" not in platform_dump(env)
