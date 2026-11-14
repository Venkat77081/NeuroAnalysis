import hashlib
from urllib.parse import urlparse

H = hashlib.sha256


def register(api):
    r = api.post(
        "/auth/device-register",
        json={"enrollment_code": "ENROL-123456", "model": "OnePlus", "os_version": "17"},
    )
    assert r.status_code == 201, r.text
    return r.json()


def login(api, dev, code="OP-07", pin="2468"):
    r = api.post(
        "/auth/login",
        json={
            "device_id": dev["device_id"],
            "device_secret": dev["device_secret"],
            "operator_code": code,
            "pin": pin,
        },
    )
    return r


def auth(tok):
    return {"Authorization": f"Bearer {tok['access_token']}"}


SESSION = {
    "client_session_id": "s-local-1",
    "patient": {"ref_hash": "a" * 64, "year_of_birth": 1958, "sex": "M"},
    "med_state": "ON",
    "started_at": "2026-11-14T10:00:00Z",
    "consent_version": "CONSENT@1.0",
    "consent_at": "2026-11-14T09:59:00Z",
    "app_version": "0.3.0",
    "config_versions": {"session": "SESSION@2.1.0", "FT": "FT@2.4.0"},
}


def take_body(session_id, files):
    return {
        "session_id": session_id,
        "client_take_id": "tk-1",
        "test_code": "FT",
        "side": None,
        "take_no": 1,
        "capture_verdict": "PASS",
        "flagged_for_review": False,
        "quality": {"captureVerdict": "PASS"},
        "meta": {"takeId": "tk-1"},
        "wrapped_data_key": "d3JhcHBlZA==",
        "key_id": "dev-key-1",
        "files": [{"kind": k, "size_bytes": len(v), "sha256": H(v).hexdigest()} for k, v in files.items()],
    }


def put(api, url, data):
    u = urlparse(url)
    return api.put(f"{u.path}?{u.query}", content=data)


def upload_parts(api, plan_file, data, only=None):
    size = plan_file["part_size"]
    etags = {}
    for p in plan_file["parts"]:
        if only is not None and p["number"] not in only:
            continue
        chunk = data[(p["number"] - 1) * size : p["number"] * size]
        r = put(api, p["url"], chunk)
        assert r.status_code == 200, r.text
        etags[p["number"]] = r.headers["ETag"]
    return etags


def test_full_upload_with_resume_and_checksum_mismatch(api, site):
    dev = register(api)
    assert dev["patient_ref_salt"] == site["salt"]
    assert "BEGIN PUBLIC KEY" in dev["server_key"]["public_key_pem"]
    tok = login(api, dev).json()
    s = api.post("/sessions", json=SESSION, headers=auth(tok))
    assert s.status_code == 201
    sid = s.json()["id"]
    # Idempotent: a retried create returns the same session.
    assert api.post("/sessions", json=SESSION, headers=auth(tok)).json()["id"] == sid

    video = bytes(range(256)) * 10  # 2560 bytes → 3 parts of 1 KiB
    quality = b'{"captureVerdict":"PASS"}'
    plan = api.post("/takes", json=take_body(sid, {"video": video, "quality": quality}), headers=auth(tok))
    assert plan.status_code == 201, plan.text
    take_id = plan.json()["take_id"]
    vf = next(f for f in plan.json()["files"] if f["kind"] == "video")
    assert vf["parts_total"] == 3

    # Network loss after part 1: resume asks the server what is missing.
    etags = upload_parts(api, vf, video, only={1})
    resume = api.get(f"/takes/{take_id}/upload", headers=auth(tok)).json()
    vf2 = next(f for f in resume["files"] if f["kind"] == "video")
    assert [p["number"] for p in vf2["uploaded_parts"]] == [1]
    assert vf2["uploaded_parts"][0]["etag"] == etags[1].strip('"')
    assert [p["number"] for p in vf2["parts"]] == [2, 3]
    # Retried POST /takes (lost response) gives the same take and the same resume plan.
    again = api.post("/takes", json=take_body(sid, {"video": video, "quality": quality}), headers=auth(tok))
    assert again.json()["take_id"] == take_id

    # Part 3 corrupted in transit → checksum mismatch → fresh upload of that file.
    etags |= upload_parts(api, vf2, video, only={2})
    bad = put(api, vf2["parts"][1]["url"], b"x" * (len(video) - 2048))
    etags[3] = bad.headers["ETag"]
    r = api.post(
        f"/takes/{take_id}/files/video/complete",
        json={"parts": [{"number": n, "etag": e} for n, e in etags.items()]},
        headers=auth(tok),
    )
    assert r.status_code == 409 and r.json()["detail"]["code"] == "checksum_mismatch"
    # Take cannot complete while a file is unverified.
    assert api.post(f"/takes/{take_id}/complete", headers=auth(tok)).status_code == 409

    fresh = api.get(f"/takes/{take_id}/upload", headers=auth(tok)).json()
    vf3 = next(f for f in fresh["files"] if f["kind"] == "video")
    assert vf3["uploaded_parts"] == [] and len(vf3["parts"]) == 3
    etags = upload_parts(api, vf3, video)
    r = api.post(
        f"/takes/{take_id}/files/video/complete",
        json={"parts": [{"number": n, "etag": e} for n, e in etags.items()]},
        headers=auth(tok),
    )
    assert r.status_code == 200
    qf = next(f for f in r.json()["files"] if f["kind"] == "quality")
    q_etags = upload_parts(api, qf, quality)
    r = api.post(
        f"/takes/{take_id}/files/quality/complete",
        json={"parts": [{"number": n, "etag": e} for n, e in q_etags.items()]},
        headers=auth(tok),
    )
    assert all(f["verified"] for f in r.json()["files"])
    done = api.post(f"/takes/{take_id}/complete", headers=auth(tok))
    assert done.status_code == 200 and done.json()["status"] == "complete"
    assert api.post(f"/takes/{take_id}/complete", headers=auth(tok)).status_code == 200  # idempotent

    # Reviewer sees it; operator may not list.
    rv = login(api, dev, "RV-01", "1357").json()
    rows = api.get(f"/takes?session_id={sid}", headers=auth(rv)).json()
    assert [r["status"] for r in rows] == ["complete"]
    assert api.get("/takes", headers=auth(tok)).status_code == 403
    assert api.get("/takes?flagged=true", headers=auth(rv)).json() == []

    closed = api.patch(
        f"/sessions/{sid}",
        json={"ended_at": "2026-11-14T10:20:00Z", "aborted": {"reason": "patient_unwell"}},
        headers=auth(tok),
    )
    assert closed.status_code == 200


def test_auth_rules(api, site):
    assert (
        api.post(
            "/auth/device-register", json={"enrollment_code": "WRONG-CODE", "model": "x", "os_version": "1"}
        ).status_code
        == 403
    )
    dev = register(api)
    assert login(api, dev, pin="0000").status_code == 401
    bad = {**dev, "device_secret": "nope"}
    assert login(api, bad).status_code == 401
    tok = login(api, dev).json()
    assert api.post("/sessions", json=SESSION).status_code == 401
    assert api.post("/sessions", json=SESSION, headers={"Authorization": "Bearer junk"}).status_code == 401

    # Refresh rotates: the old refresh token works once.
    new = api.post("/auth/refresh", json={"refresh_token": tok["refresh_token"]})
    assert new.status_code == 200
    assert api.post("/auth/refresh", json={"refresh_token": tok["refresh_token"]}).status_code == 401

    # Tier: report and read back.
    t = api.put(
        f"/devices/{dev['device_id']}/qualification", json={"tier": "A", "report": {}}, headers=auth(tok)
    )
    assert t.json()["tier"] == "A"
    assert api.get(f"/devices/{dev['device_id']}/tier", headers=auth(tok)).json()["tier"] == "A"
    assert (
        api.put(
            f"/devices/{dev['device_id']}/qualification", json={"tier": "Z", "report": {}}, headers=auth(tok)
        ).status_code
        == 422
    )

    # Lost device: admin revokes it; its tokens stop working.
    other = register(api)
    admin = login(api, other, "AD-01", "9999").json()
    assert api.post(f"/auth/devices/{dev['device_id']}/revoke", headers=auth(tok)).status_code == 403
    assert api.post(f"/auth/devices/{dev['device_id']}/revoke", headers=auth(admin)).status_code == 204
    assert api.post("/sessions", json=SESSION, headers=auth(new.json())).status_code == 401
    assert api.post("/auth/refresh", json={"refresh_token": new.json()["refresh_token"]}).status_code == 401
    assert login(api, dev).status_code == 401


def test_take_validation_and_storage_signatures(api, site):
    dev = register(api)
    tok = login(api, dev).json()
    sid = api.post("/sessions", json=SESSION, headers=auth(tok)).json()["id"]
    body = take_body(sid, {"quality": b"{}"})
    assert api.post("/takes", json=body, headers=auth(tok)).status_code == 422  # video required
    body = take_body("nope", {"video": b"v"})
    assert api.post("/takes", json=body, headers=auth(tok)).status_code == 404
    plan = api.post("/takes", json=take_body(sid, {"video": b"v"}), headers=auth(tok)).json()
    url = plan["files"][0]["parts"][0]["url"]
    tampered = url.replace("sig=", "sig=0")
    assert put(api, tampered, b"v").status_code == 403
    assert api.get("/takes/unknown/upload", headers=auth(tok)).status_code == 404
