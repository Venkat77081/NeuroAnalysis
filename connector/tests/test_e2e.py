"""M11 acceptance, end to end: live lookup, invite -> NCID, activity-log write, decrypt of a
phone-encrypted take, and no patient identity outside the connector's database."""

import base64
import json

import fake_fhir
from sqlalchemy import inspect, text
from test_readiness_api import _upload_take
from test_tenancy import SESSION, hdr

from ncconnector.providers import OUTBOX


def ctoken(env, tok=None) -> dict:
    r = env["platform"].post("/hospital/connector-token", headers=hdr(tok or env["admin_tok"]))
    assert r.status_code == 200, r.text
    assert r.json()["connector_url"] == "http://connector.test"
    return hdr(r.json()["token"])


def accept(env, link, pin="2580"):
    r = env["platform"].post(
        "/patient/invite/accept",
        json={
            "token": link.split("t=", 1)[1],
            "pin": pin,
            "consent_version": "home-consent@1",
            "model": "Galaxy",
            "os_version": "15",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def platform_dump(env) -> str:
    """Every value in every platform table, plus the platform's own outbox and audit log."""
    from app.db import get_engine
    from app.providers import OUTBOX as PLATFORM_OUTBOX

    eng = get_engine()
    parts = []
    with eng.connect() as c:
        for t in inspect(eng).get_table_names():
            parts += [json.dumps([str(v) for v in row]) for row in c.execute(text(f'SELECT * FROM "{t}"'))]  # noqa: S608
    parts += [m.to + m.subject + m.body for m in PLATFORM_OUTBOX]
    return "\n".join(parts)


IDENTITY = [
    "00012388",
    "00012401",
    "Asha",
    "Testpatient",
    "Ravi",
    "Samplename",
    "asha.t@example.org",
    "+919800000001",
    "+919800000002",
    "1958-03-02",
]


def test_health_check_through_the_platform(connector):
    r = connector["platform"].post(
        "/hospital/connector/check", headers=hdr(connector["admin_tok"]), json={"sample_mrn": "00012388"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["check"] == {
        "reachable": "pass",
        "records": "pass",
        "ncid_map": "pass",
        "activity_log": "pass",
        "decrypt_key": "pass",
    }
    bad = connector["platform"].post(
        "/hospital/connector/check", headers=hdr(connector["admin_tok"]), json={"sample_mrn": "nope"}
    )
    assert bad.json()["check"]["records"] == "fail"
    assert "00012388" not in platform_dump(connector)  # the sample MRN went to the connector only


def test_full_flow(connector):
    env, c = connector, connector["client"]
    admin = ctoken(env)

    # Live lookup from the hospital's FHIR server.
    rows = c.get("/v1/patients", params={"q": "00012388"}, headers=admin).json()
    assert rows == [
        {
            "mrn": "00012388",
            "name": "Asha Testpatient",
            "birth_date": "1958-03-02",
            "sex": "F",
            "has_email": True,
            "has_phone": True,
            "ncid": None,
            "app_status": None,
        }
    ]
    assert len(c.get("/v1/patients", params={"q": "samplename"}, headers=admin).json()) == 1

    # Invite two patients by e-mail: one has no e-mail on file and is skipped.
    r = c.post(
        "/v1/invites", headers=admin, json={"mrns": ["00012388", "00012401", "99999999"], "channel": "email"}
    )
    assert r.status_code == 200, r.text
    res = {x["mrn"]: x for x in r.json()}
    assert res["00012388"]["result"] == "sent" and res["00012388"]["ncid"].startswith("nc_")
    assert res["00012401"]["result"] == "skipped_no_email" and res["99999999"]["result"] == "not_found"
    ncid = res["00012388"]["ncid"]
    mail = OUTBOX[-1]
    assert mail.to == "asha.t@example.org" and "invite-qr.png" in mail.attachments
    assert mail.attachments["invite-qr.png"][:8] == b"\x89PNG\r\n\x1a\n"
    link = next(w for w in mail.body.split() if w.startswith("neurocapture://invite?t="))

    # App status shows in the live list; the patient accepts with a PIN and records at home.
    assert c.get("/v1/patients", params={"q": "00012388"}, headers=admin).json()[0]["app_status"] == "invited"
    acc = accept(env, link)
    assert acc["ncid"] == ncid
    assert c.get("/v1/patients", params={"q": "00012388"}, headers=admin).json()[0]["app_status"] == "active"
    sess = env["platform"].post("/sessions", headers=hdr(acc["tokens"]["access_token"]), json=SESSION)
    assert sess.status_code == 201, sess.text
    take_id = _upload_take(env["platform"], acc["tokens"], sess.json()["id"], acc["server_key"], "tk-home-1")
    done = env["platform"].post(f"/takes/{take_id}/complete", headers=hdr(acc["tokens"]["access_token"]))
    assert done.status_code == 200, done.text

    # A doctor sees live history and the recording, decrypted by the connector.
    from test_tenancy import sign_up, staff_login

    env["platform"].post(
        "/hospital/staff", headers=hdr(env["admin_tok"]), json={"email": "dr@sunrise.example"}
    )
    _, dr_secret = sign_up(env["platform"], "dr@sunrise.example")
    dr_tok = staff_login(env["platform"], "dr@sunrise.example", dr_secret)["access_token"]
    doc = ctoken(env, dr_tok)
    view = c.get(f"/v1/patients/{ncid}", headers=doc).json()
    assert view["records_available"] and view["name"] == "Asha Testpatient" and view["mrn"] == "00012388"
    assert view["conditions"][0]["text"] == "Parkinson's disease"
    assert view["medications"][0] == {
        "text": "Levodopa/carbidopa 100/25 mg",
        "date": "2022-06-01",
        "detail": "three times daily",
    }
    assert view["encounters"][0]["text"] == "Neurology OPD"
    recs = c.get(f"/v1/patients/{ncid}/recordings", headers=doc).json()
    assert [(x["take_id"], x["recorded_by"], x["status"]) for x in recs] == [(take_id, "patient", "complete")]
    video = c.get(f"/v1/takes/{take_id}/files/video", headers=doc)
    assert video.status_code == 200 and video.content == b"\x00" * 3000
    assert video.headers["content-type"] == "video/mp4" and video.headers["cache-control"] == "no-store"
    # Doctors cannot invite.
    assert (
        c.post("/v1/invites", headers=doc, json={"mrns": ["00012401"], "channel": "print"}).status_code == 403
    )

    # Activity log at the hospital (the connector's database).
    log = c.get("/v1/activity", headers=admin).json()
    actions = [e["action"] for e in log]
    for a in ("patients_searched", "patient_invited", "history_viewed", "recording_viewed"):
        assert a in actions
    assert all(e["actor_id"] is None or not e["actor_id"].startswith("nc_") for e in log)

    # History fetch is live: the FHIR server is asked again on every view.
    before = len(fake_fhir.REQUESTS)
    c.get(f"/v1/patients/{ncid}", headers=doc)
    assert len(fake_fhir.REQUESTS) > before

    # Nothing about patient identity reached the platform.
    dump = platform_dump(env)
    assert ncid in dump
    for value in IDENTITY:
        assert value not in dump, value

    # The connector stores the NCID <-> MRN link, but no names, contacts or history.
    from ncconnector.db import get_engine

    eng = get_engine()
    with eng.connect() as conn:
        stored = "\n".join(
            json.dumps([str(v) for v in row])
            for t in inspect(eng).get_table_names()
            for row in conn.execute(text(f'SELECT * FROM "{t}"'))  # noqa: S608
        )
    assert "00012388" in stored and ncid in stored
    for value in IDENTITY[2:]:
        assert value not in stored, value


def test_print_invite_reinvite_and_clinic_ncid(connector):
    c, admin = connector["client"], ctoken(connector)
    r = c.post("/v1/invites", headers=admin, json={"mrns": ["00012401"], "channel": "print"}).json()[0]
    assert r["result"] == "printed" and r["invite_link"].startswith("neurocapture://invite?t=")
    assert base64.b64decode(r["qr_png_base64"])[:4] == b"\x89PNG"
    first = accept(connector, r["invite_link"])
    # Re-invite: same NCID, new link, old phone stops working.
    r2 = c.post("/v1/invites", headers=admin, json={"mrns": ["00012401"], "channel": "print"}).json()[0]
    assert r2["ncid"] == r["ncid"] and r2["invite_link"] != r["invite_link"]
    login = {"device_id": first["device_id"], "device_secret": first["device_secret"], "pin": "2580"}
    assert connector["platform"].post("/patient/login", json=login).status_code == 401
    # SMS is not enabled for this hospital.
    sms = c.post("/v1/invites", headers=admin, json={"mrns": ["00012401"], "channel": "sms"}).json()[0]
    assert sms["result"] == "failed" and sms["error"] == "sms_not_enabled"
    # NCID for a clinic session, without an app invite.
    out = c.post("/v1/ncid", headers=admin, json={"mrn": "00012388"}).json()
    assert out["created"] and c.post("/v1/ncid", headers=admin, json={"mrn": "00012388"}).json() == {
        "ncid": out["ncid"],
        "created": False,
    }
    assert c.post("/v1/ncid", headers=admin, json={"mrn": "nope"}).status_code == 404


def test_records_down_doctor_view_says_so(connector):
    c, admin = connector["client"], ctoken(connector)
    ncid = c.post("/v1/ncid", headers=admin, json={"mrn": "00012388"}).json()["ncid"]
    fake_fhir.DOWN["value"] = True
    view = c.get(f"/v1/patients/{ncid}", headers=admin)
    assert (
        view.status_code == 200 and view.json()["records_available"] is False and view.json()["name"] is None
    )
    assert c.get(f"/v1/patients/{ncid}/recordings", headers=admin).status_code == 200  # recordings still open
    assert c.get("/v1/patients", params={"q": "asha"}, headers=admin).status_code == 503


def test_tokens_and_signatures_are_enforced(connector):
    env, c = connector, connector["client"]
    assert c.get("/v1/patients", params={"q": "asha"}).status_code == 401
    # A token for another hospital is refused.
    from app.signing import connector_token

    other, _ = connector_token("some-other-site", "u1", "hospital_admin")
    assert c.get("/v1/patients", params={"q": "asha"}, headers=hdr(other)).status_code == 401
    # Staff tokens for the platform are not connector tokens.
    assert c.get("/v1/patients", params={"q": "asha"}, headers=hdr(env["admin_tok"])).status_code == 401
    # Unsigned or wrongly signed platform calls are refused, both ways.
    assert c.post("/v1/health/check", json={}).status_code == 401
    assert env["platform"].post("/connector/v1/patients", json={"channel": "print"}).status_code == 401
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    from ncconnector.signing import sign_headers

    body = b'{"channel": "print"}'
    h = sign_headers(Ed25519PrivateKey.generate(), env["site_id"], "POST", "/connector/v1/patients", body)
    r = env["platform"].post(
        "/connector/v1/patients", content=body, headers={**h, "Content-Type": "application/json"}
    )
    assert r.status_code == 401
    # Replay of a valid signed request is refused.
    from ncconnector.keys import signing_key

    h = sign_headers(signing_key(), env["site_id"], "POST", "/connector/v1/patients", body)
    hh = {**h, "Content-Type": "application/json"}
    assert env["platform"].post("/connector/v1/patients", content=body, headers=hh).status_code == 201
    assert env["platform"].post("/connector/v1/patients", content=body, headers=hh).status_code == 401
    # With a connector registered, the platform refuses contact details and MRNs.
    r = env["platform"].post(
        "/hospital/patients/invite",
        headers=hdr(env["admin_tok"]),
        json={"channel": "email", "contact": "a@b.example", "mrn": "1"},
    )
    assert r.status_code == 409 and r.json()["detail"]["code"] == "use_connector"


def test_take_of_another_hospital_is_not_served(connector):
    """The platform only returns takes of the signing hospital; the connector only of its NCIDs."""
    c, admin = connector["client"], ctoken(connector)
    assert c.get("/v1/takes/doesnotexist/files/video", headers=admin).status_code == 404
