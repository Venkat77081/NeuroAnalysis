"""M8: reviewer readiness reports on an uploaded take, decrypted on the server."""

import hashlib
import json
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from test_upload_flow import SESSION, auth, login, register, upload_parts

from analysis.takecrypto import encrypt_file, new_data_keyset, wrap_data_key

GOLDEN = Path(__file__).resolve().parents[2] / "contracts/tests/readiness"


def _upload_take(api, tok, sid, server_key, client_take_id="tk-r1"):
    case = json.loads((GOLDEN / "ft-partial-landmarks.json").read_text())
    keyset = new_data_keyset()
    pub = serialization.load_pem_public_key(server_key["public_key_pem"].encode())
    files = {
        "landmarks": encrypt_file(
            keyset, client_take_id, "landmarks", (GOLDEN / case["landmarksFile"]).read_bytes()
        ),
        "video": encrypt_file(keyset, client_take_id, "video", b"\x00" * 3000),
    }
    quality = {
        "captureVerdict": "PASS",
        "fpsEffective": 59.9,
        "durationS": 15,
        "movementWindow": None,
        "biomarkerReadinessHint": {"registryVersion": "REG@0.1.0", "FT1": {"status": "COMPUTABLE"}},
        "replayInputs": {"firstSampleNs": case["evidence"]["startNs"], "hasSensors": False},
    }
    body = {
        "session_id": sid,
        "client_take_id": client_take_id,
        "test_code": "FT",
        "side": None,
        "take_no": 1,
        "capture_verdict": "PASS",
        "quality": quality,
        "meta": {},
        "wrapped_data_key": wrap_data_key(keyset, pub),
        "key_id": server_key["key_id"],
        "files": [
            {"kind": k, "size_bytes": len(v), "sha256": hashlib.sha256(v).hexdigest()}
            for k, v in files.items()
        ],
    }
    resp = api.post("/takes", json=body, headers=auth(tok))
    assert resp.status_code == 201, resp.text
    plan = resp.json()
    take_id = plan["take_id"]
    for f in plan["files"]:
        etags = upload_parts(api, f, files[f["kind"]])
        r = api.post(
            f"/takes/{take_id}/files/{f['kind']}/complete",
            json={"parts": [{"number": n, "etag": e} for n, e in etags.items()]},
            headers=auth(tok),
        )
        assert r.status_code == 200, r.text
    return take_id


def test_reviewer_readiness_per_take_and_session(api, site):
    dev = register(api)
    op = login(api, dev).json()
    rv = login(api, dev, "RV-01", "1357").json()
    sid = api.post("/sessions", json=SESSION, headers=auth(op)).json()["id"]
    take_id = _upload_take(api, op, sid, dev["server_key"])
    # Not uploaded yet → no report.
    assert api.get(f"/takes/{take_id}/readiness", headers=auth(rv)).status_code == 409
    assert api.post(f"/takes/{take_id}/complete", headers=auth(op)).status_code == 200

    # Operators never see readiness.
    assert api.get(f"/takes/{take_id}/readiness", headers=auth(op)).status_code == 403
    r = api.get(f"/takes/{take_id}/readiness", headers=auth(rv))
    assert r.status_code == 200, r.text
    rep = r.json()
    assert rep["source"] == "server" and rep["status"] == "ready"
    ids = [b["id"] for b in rep["biomarkers"]]
    assert ids == [f"FT{i}" for i in range(1, 13)]  # every registered FT biomarker
    assert rep["biomarkers"][0] == {
        "id": "FT1",
        "status": "PARTIAL",
        "reason": "required landmarks visible in 66.7% of frames; needs 90%",
        "retakeFixable": True,
        "missing": ["landmarks"],
        "qualityRules": ["in_safe_zone", "required_landmarks_visible", "subject_present"],
    }
    assert rep["summary"] == {"PARTIAL": 12}

    again = api.post(f"/takes/{take_id}/readiness", headers=auth(rv)).json()
    assert again["computedAt"] >= rep["computedAt"]
    sess = api.get(f"/sessions/{sid}/readiness", headers=auth(rv)).json()
    assert sess["byTest"] == {"FT": {"PARTIAL": 12}}
    assert len(sess["takes"]) == 1
    assert api.get("/sessions/nope/readiness", headers=auth(rv)).status_code == 404


def test_without_the_private_key_the_phone_hint_is_reported(api, site, monkeypatch):
    from app import readiness

    monkeypatch.setattr(readiness, "server_private_key", lambda key_id: None)
    dev = register(api)
    op = login(api, dev).json()
    ad = login(api, dev, "AD-01", "9999").json()
    sid = api.post("/sessions", json=SESSION, headers=auth(op)).json()["id"]
    take_id = _upload_take(api, op, sid, dev["server_key"], "tk-r2")
    api.post(f"/takes/{take_id}/complete", headers=auth(op))
    rep = api.get(f"/takes/{take_id}/readiness", headers=auth(ad)).json()
    assert rep["source"] == "device_hint"
    assert rep["biomarkers"][0]["status"] == "COMPUTABLE"
    assert rep["biomarkers"][1]["reason"] == "not assessed (registry REG@0.1.0)"
    assert len(rep["biomarkers"]) == 12


def test_a_take_that_cannot_be_decrypted_is_reported_as_error(api, site, monkeypatch):
    dev = register(api)
    op = login(api, dev).json()
    rv = login(api, dev, "RV-01", "1357").json()
    sid = api.post("/sessions", json=SESSION, headers=auth(op)).json()["id"]
    other = dict(dev["server_key"])
    from cryptography.hazmat.primitives.asymmetric import rsa

    wrong = rsa.generate_private_key(public_exponent=65537, key_size=2048).public_key()
    other["public_key_pem"] = wrong.public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()
    take_id = _upload_take(api, op, sid, other, "tk-r3")
    api.post(f"/takes/{take_id}/complete", headers=auth(op))
    rep = api.get(f"/takes/{take_id}/readiness", headers=auth(rv)).json()
    assert rep["status"] == "error"
    assert rep["biomarkers"][0]["reason"].startswith("readiness failed:")


def test_export_take_for_replay(api, site, tmp_path):
    from analysis.export_take import export_take

    dev = register(api)
    op = login(api, dev).json()
    sid = api.post("/sessions", json=SESSION, headers=auth(op)).json()["id"]
    take_id = _upload_take(api, op, sid, dev["server_key"], "tk-r4")
    assert export_take(take_id, tmp_path / "t") == ["landmarks.bin", "quality.json"]
    case = json.loads((GOLDEN / "ft-partial-landmarks.json").read_text())
    assert (tmp_path / "t/landmarks.bin").read_bytes() == (GOLDEN / case["landmarksFile"]).read_bytes()
