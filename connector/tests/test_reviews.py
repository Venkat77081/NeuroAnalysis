"""M14: doctor reviews stay at the hospital; the dashboard's live name lookup by NCID."""

from test_e2e import accept, assign, ctoken, platform_dump
from test_readiness_api import _upload_take
from test_tenancy import SESSION, hdr, sign_up, staff_login


def test_review_and_lookup(connector):
    env, c = connector, connector["client"]
    admin = ctoken(env)
    r = c.post("/v1/invites", headers=admin, json={"mrns": ["00012388"], "channel": "print"}).json()[0]
    acc = accept(env, r["invite_link"])
    sid = (
        env["platform"]
        .post("/sessions", headers=hdr(acc["tokens"]["access_token"]), json=SESSION)
        .json()["id"]
    )
    take_id = _upload_take(env["platform"], acc["tokens"], sid, acc["server_key"], "tk-rev")
    env["platform"].post(f"/takes/{take_id}/complete", headers=hdr(acc["tokens"]["access_token"]))

    rows = c.post("/v1/patients/lookup", headers=admin, json={"ncids": [r["ncid"], "nc_" + "0" * 32]}).json()
    assert [(x["ncid"], x["mrn"], x["name"]) for x in rows] == [(r["ncid"], "00012388", "Asha Testpatient")]

    env["platform"].post(
        "/hospital/staff", headers=hdr(env["admin_tok"]), json={"email": "dr@sunrise.example"}
    )
    _, secret = sign_up(env["platform"], "dr@sunrise.example")
    doc = ctoken(env, staff_login(env["platform"], "dr@sunrise.example", secret)["access_token"])
    assign(env, r["ncid"], "dr@sunrise.example")
    note = "Hands partly out of frame; Asha to retake on Friday"
    assert c.post(f"/v1/takes/{take_id}/review", headers=admin, json={"usable": False}).status_code == 403
    rv = c.post(f"/v1/takes/{take_id}/review", headers=doc, json={"usable": False, "note": note})
    assert rv.status_code == 201, rv.text
    got = c.get(f"/v1/patients/{r['ncid']}/reviews", headers=doc).json()
    assert [(x["take_id"], x["usable"], x["note"]) for x in got] == [(take_id, False, note)]
    assert "take_reviewed" in [
        e["action"] for e in c.get("/v1/activity", headers=ctoken(env, env["admin_tok"])).json()
    ]
    # The note (with a name in it) never reached the platform.
    dump = platform_dump(env)
    assert "retake on Friday" not in dump and "Asha" not in dump
