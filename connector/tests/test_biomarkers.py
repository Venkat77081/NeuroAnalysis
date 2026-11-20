"""M15 (decision 059): biomarkers are computed at the hospital and the report stays there."""

from pathlib import Path

from test_e2e import accept, assign, ctoken, platform_dump
from test_readiness_api import _upload_take
from test_tenancy import SESSION, hdr, sign_up, staff_login

from ncconnector import biomarkers
from ncconnector.db import BiomarkerRun, factory


def _setup(env, client_take_id="tk-bio"):
    c = env["client"]
    admin = ctoken(env)
    r = c.post("/v1/invites", headers=admin, json={"mrns": ["00012388"], "channel": "print"}).json()[0]
    acc = accept(env, r["invite_link"])
    tok = acc["tokens"]["access_token"]
    sid = env["platform"].post("/sessions", headers=hdr(tok), json=SESSION).json()["id"]
    take_id = _upload_take(env["platform"], acc["tokens"], sid, acc["server_key"], client_take_id)
    env["platform"].post(f"/takes/{take_id}/complete", headers=hdr(tok))
    env["platform"].post(
        "/hospital/staff", headers=hdr(env["admin_tok"]), json={"email": "dr@sunrise.example"}
    )
    _, secret = sign_up(env["platform"], "dr@sunrise.example")
    doc = ctoken(env, staff_login(env["platform"], "dr@sunrise.example", secret)["access_token"])
    assign(env, r["ncid"], "dr@sunrise.example")
    return admin, doc, r["ncid"], take_id


def test_doctor_analyses_a_take_and_reads_the_report(connector, monkeypatch):
    env, c = connector, connector["client"]
    calls: list[tuple[bytes, str, str, Path]] = []

    def fake(video: Path, test: str, ncid: str):
        calls.append((video.read_bytes(), test, ncid, video))
        return {"testCode": test, "biomarkers": [{"id": "FT1", "value": 0.42}]}, "<p>FT report 0.420</p>"

    monkeypatch.setattr(biomarkers, "ANALYSER", fake)
    admin, doc, ncid, take_id = _setup(env)
    assert c.get("/v1/biomarkers", headers=doc).json() == {"installed": True, "tests": ["FT"]}
    assert c.post(f"/v1/takes/{take_id}/biomarkers", headers=admin).status_code == 403

    r = c.post(f"/v1/takes/{take_id}/biomarkers", headers=doc)
    assert r.status_code == 202, r.text
    assert r.json()["status"] == "running"
    biomarkers.wait_idle()
    # The analyser got the decrypted video; the temporary copy is gone afterwards.
    assert calls[0][0] == b"\x00" * 3000 and calls[0][1:3] == ("FT", ncid)
    assert not calls[0][3].exists()

    runs = c.get(f"/v1/patients/{ncid}/biomarkers", headers=doc).json()
    assert [(x["take_id"], x["status"], x["test_code"]) for x in runs] == [(take_id, "done", "FT")]
    rep = c.get(f"/v1/takes/{take_id}/biomarkers/report", headers=doc)
    assert rep.status_code == 200 and "FT report 0.420" in rep.text
    assert rep.headers["content-type"].startswith("text/html")
    assert "default-src 'none'" in rep.headers["content-security-policy"]

    # Asked again: the finished run is returned, not repeated, unless "again".
    assert c.post(f"/v1/takes/{take_id}/biomarkers", headers=doc).json()["status"] == "done"
    assert len(calls) == 1
    assert c.post(f"/v1/takes/{take_id}/biomarkers?again=true", headers=doc).status_code == 202
    biomarkers.wait_idle()
    assert len(calls) == 2

    actions = [e["action"] for e in c.get("/v1/activity", headers=ctoken(env, env["admin_tok"])).json()]
    assert "biomarkers_requested" in actions and "biomarker_report_viewed" in actions
    # Values and report never reach the platform.
    assert "FT report 0.420" not in platform_dump(env)


def test_failed_analysis_and_not_installed(connector, monkeypatch):
    env, c = connector, connector["client"]

    def broken(video, test, ncid):
        raise RuntimeError("no hands")

    monkeypatch.setattr(biomarkers, "ANALYSER", broken)
    _, doc, ncid, take_id = _setup(env, "tk-bio2")
    c.post(f"/v1/takes/{take_id}/biomarkers", headers=doc)
    biomarkers.wait_idle()
    run = c.get(f"/v1/patients/{ncid}/biomarkers", headers=doc).json()[0]
    assert (run["status"], run["reason"]) == ("failed", "RuntimeError")
    assert c.get(f"/v1/takes/{take_id}/biomarkers/report", headers=doc).status_code == 409

    monkeypatch.setattr(biomarkers, "ANALYSER", None)
    monkeypatch.setattr(biomarkers, "analyser", lambda: None)
    r = c.post(f"/v1/takes/{take_id}/biomarkers", headers=doc)
    assert r.status_code == 501 and r.json()["detail"]["code"] == "analysis_not_installed"


def test_runs_left_running_by_a_restart_are_marked_failed(connector):
    with factory()() as db:
        db.add(
            BiomarkerRun(take_id="t" * 32, ncid="nc_x", test_code="FT", status="running", requested_by="d")
        )
        db.commit()
        assert biomarkers.fail_interrupted(db) == 1
        r = db.get(BiomarkerRun, "t" * 32)
        assert (r.status, r.reason) == ("failed", "interrupted")


def test_new_take_in_development_storage_is_analysed_automatically(connector, monkeypatch):
    """Decision 060 without a hospital bucket: the report stays in the connector's database."""
    env, c = connector, connector["client"]
    monkeypatch.setattr(
        biomarkers, "ANALYSER", lambda video, test, ncid: ({"testCode": test}, "<p>dev report</p>")
    )
    with factory()() as db:
        assert biomarkers.poll_new_takes(db) == 0
    _, doc, ncid, take_id = _setup(env, "tk-bio-auto")
    with factory()() as db:
        assert biomarkers.poll_new_takes(db) == 1
    biomarkers.wait_idle()
    runs = c.get(f"/v1/patients/{ncid}/biomarkers", headers=doc).json()
    assert [(r["take_id"], r["status"]) for r in runs] == [(take_id, "done")]
    assert "dev report" in c.get(f"/v1/takes/{take_id}/biomarkers/report", headers=doc).text
