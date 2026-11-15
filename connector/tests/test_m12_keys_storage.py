"""M12 acceptance: a take recorded on the phone is readable only by that hospital's connector, and
two hospitals' takes cannot be read with each other's keys. Also: rotation, and the hospital's
own S3 bucket through an upload-only role (moto)."""

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from test_readiness_api import _upload_take
from test_tenancy import SESSION, hdr, onboard, sign_up

from ncconnector.keys import keyring_ids, public_pem, rotate_take_key, take_private_key
from ncconnector.signing import sign_headers
from ncconnector.takecrypto import unwrap_data_key


@pytest.fixture
def env(connector, tmp_path, monkeypatch):
    from app.config import get_settings as platform_settings

    from ncconnector.config import get_settings

    monkeypatch.setattr(get_settings(), "take_keys_dir", str(tmp_path / "keys"))
    monkeypatch.setattr(platform_settings(), "require_hospital_key", True)
    return connector


def ctoken(env) -> dict:
    return hdr(
        env["platform"].post("/hospital/connector-token", headers=hdr(env["admin_tok"])).json()["token"]
    )


def patient_session(env, admin_tok, client_session_id="home-1"):
    """Print invite from the platform dashboard, accept on a phone, start a session."""
    api = env["platform"]
    inv = api.post("/hospital/patients/invite", headers=hdr(admin_tok), json={"channel": "print"}).json()
    acc = api.post(
        "/patient/invite/accept",
        json={
            "token": inv["invite_link"].split("t=", 1)[1],
            "pin": "2580",
            "consent_version": "home-consent@1",
            "model": "Galaxy",
            "os_version": "15",
        },
    ).json()
    s = api.post(
        "/sessions",
        headers=hdr(acc["tokens"]["access_token"]),
        json={**SESSION, "client_session_id": client_session_id},
    )
    assert s.status_code == 201, s.text
    return inv["ncid"], acc, s.json()


def link_ncid(ncid):
    """Pretend the hospital's records hold this NCID (print invites made on the platform)."""
    from ncconnector.db import NcidMap, factory

    with factory()() as db:
        db.add(NcidMap(ncid=ncid, mrn=f"test-{ncid[-8:]}"))
        db.commit()


def record(env, acc, sess, client_take_id):
    api = env["platform"]
    take_id = _upload_take(api, acc["tokens"], sess["id"], sess["encryption_key"], client_take_id)
    assert (
        api.post(f"/takes/{take_id}/complete", headers=hdr(acc["tokens"]["access_token"])).status_code == 200
    )
    return take_id


def signed(api, key, site_id, method, path, payload=None):
    import json

    body = b"" if payload is None else json.dumps(payload).encode()
    h = sign_headers(key, site_id, method, path, body)
    return api.request(method, path, content=body, headers={**h, "Content-Type": "application/json"})


def second_hospital(env):
    """Hospital B with its own connector signing key and take key (held here, not on A's connector)."""
    api = env["platform"]
    b_site = onboard(api, env["root_tok"], "Lakeview Hospital", "admin@lakeview.example")
    b_tok, _ = sign_up(api, "admin@lakeview.example")
    b_sign = Ed25519PrivateKey.generate()
    r = api.put(
        "/hospital/connector",
        headers=hdr(b_tok),
        json={"url": "https://connector.lakeview.example", "public_key_pem": public_pem(b_sign.public_key())},
    )
    assert r.status_code == 200
    b_take = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    pem = b_take.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    r = signed(api, b_sign, b_site, "POST", "/connector/v1/keys", {"public_key_pem": pem.decode()})
    assert r.status_code == 201, r.text
    return {"site": b_site, "tok": b_tok, "sign": b_sign, "take_key": b_take, "key_id": r.json()["key_id"]}


def test_take_readable_only_by_its_hospitals_connector(env):
    api, c = env["platform"], env["client"]
    key = rotate_take_key()
    assert key["key_id"].startswith("hk-") and keyring_ids() == [key["key_id"]]
    assert [k["key_id"] for k in api.get("/hospital/keys", headers=hdr(env["admin_tok"])).json()] == [
        key["key_id"]
    ]

    ncid, acc, sess = patient_session(env, env["admin_tok"])
    assert sess["encryption_key"]["owner"] == "hospital" and sess["encryption_key"]["key_id"] == key["key_id"]
    # A take wrapped with any other key (e.g. the platform's) is refused.
    wrong = {
        **sess["encryption_key"],
        "key_id": acc["server_key"]["key_id"],
        "public_key_pem": acc["server_key"]["public_key_pem"],
    }
    with pytest.raises(AssertionError, match="wrong_key"):
        _upload_take(api, acc["tokens"], sess["id"], wrong, "tk-wrong")
    take_id = record(env, acc, sess, "tk-a1")
    link_ncid(ncid)

    # The hospital's connector decrypts it.
    r = c.get(f"/v1/takes/{take_id}/files/video", headers=ctoken(env))
    assert r.status_code == 200 and r.content == b"\x00" * 3000

    # The platform cannot: its key does not unwrap the data key, and readiness falls back to the hint.
    from app.db import _factory
    from app.keys import _ephemeral
    from app.models import Take
    from app.readiness import compute

    with _factory()() as db:
        take = db.get(Take, take_id)
        with pytest.raises(ValueError):
            unwrap_data_key(take.wrapped_data_key, _ephemeral())
        assert compute(db, take, None).source == "device_hint"

    # Hospital B cannot fetch A's take, and B's key cannot unwrap it.
    b = second_hospital(env)
    assert signed(api, b["sign"], b["site"], "GET", f"/connector/v1/takes/{take_id}").status_code == 404
    with pytest.raises(ValueError):
        unwrap_data_key(take.wrapped_data_key, b["take_key"])

    # And A's connector cannot read B's take: not served to A, and A's key cannot unwrap it.
    b_ncid, b_acc, b_sess = patient_session(env, b["tok"], "home-b1")
    assert b_sess["encryption_key"]["key_id"] == b["key_id"]
    b_take_id = record(env, b_acc, b_sess, "tk-b1")
    link_ncid(b_ncid)  # even if A's map somehow held B's NCID
    assert c.get(f"/v1/takes/{b_take_id}/files/video", headers=ctoken(env)).status_code == 404
    with _factory()() as db:
        b_take = db.get(Take, b_take_id)
        with pytest.raises(ValueError):
            unwrap_data_key(b_take.wrapped_data_key, take_private_key(key["key_id"]))
        assert unwrap_data_key(b_take.wrapped_data_key, b["take_key"])  # only B's own key works


def test_rotation(env):
    api, c = env["platform"], env["client"]
    k1 = rotate_take_key()
    ncid, acc, s1 = patient_session(env, env["admin_tok"])
    link_ncid(ncid)
    t1 = record(env, acc, s1, "tk-1")
    k2 = rotate_take_key()
    assert k2["retired_key_id"] == k1["key_id"]
    keys = {k["key_id"]: k["status"] for k in api.get("/hospital/keys", headers=hdr(env["admin_tok"])).json()}
    assert keys == {k1["key_id"]: "retired", k2["key_id"]: "active"}
    # A session that started before the rotation keeps its key; new sessions get the new one.
    t1b = record(env, acc, s1, "tk-1b")
    s2 = api.post(
        "/sessions",
        headers=hdr(acc["tokens"]["access_token"]),
        json={**SESSION, "client_session_id": "home-2"},
    ).json()
    assert s2["encryption_key"]["key_id"] == k2["key_id"]
    t2 = record(env, acc, s2, "tk-2")
    for t in (t1, t1b, t2):
        assert c.get(f"/v1/takes/{t}/files/video", headers=ctoken(env)).status_code == 200
    # Re-registering an old key is refused; a small key is refused.
    old_pub = (
        take_private_key(k1["key_id"])
        .public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        .decode()
    )
    from ncconnector import platform

    with pytest.raises(platform.PlatformError) as e:
        platform.call("POST", "/connector/v1/keys", {"public_key_pem": old_pub})
    assert e.value.status_code == 409
    small = (
        rsa.generate_private_key(public_exponent=65537, key_size=2048)
        .public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        .decode()
    )
    with pytest.raises(platform.PlatformError) as e:
        platform.call("POST", "/connector/v1/keys", {"public_key_pem": small})
    assert e.value.status_code == 422


def test_every_hospital_needs_a_key(env, monkeypatch):
    """Decision 027: no platform-key fallback, managed or not."""
    from app.config import get_settings as platform_settings

    monkeypatch.setattr(platform_settings(), "require_hospital_key", True)
    api = env["platform"]
    onboard(api, env["root_tok"], "Managed Clinic", "admin@managed.example")
    b_tok, _ = sign_up(api, "admin@managed.example")
    inv = api.post("/hospital/patients/invite", headers=hdr(b_tok), json={"channel": "print"}).json()
    acc = api.post(
        "/patient/invite/accept",
        json={
            "token": inv["invite_link"].split("t=", 1)[1],
            "pin": "2580",
            "consent_version": "home-consent@1",
            "model": "G",
            "os_version": "1",
        },
    ).json()
    r = api.post("/sessions", headers=hdr(acc["tokens"]["access_token"]), json=SESSION)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "no_hospital_key"


# --- The hospital's own bucket (moto) ---


@pytest.fixture
def aws(monkeypatch):
    moto = pytest.importorskip("moto")
    for k, v in {
        "AWS_ACCESS_KEY_ID": "testing",
        "AWS_SECRET_ACCESS_KEY": "testing",
        "AWS_DEFAULT_REGION": "ap-south-1",
    }.items():
        monkeypatch.setenv(k, v)
    with moto.mock_aws():
        import boto3

        boto3.client("s3", region_name="ap-south-1").create_bucket(
            Bucket="sunrise-recordings", CreateBucketConfiguration={"LocationConstraint": "ap-south-1"}
        )
        from app.storage.sites import clear_cache

        clear_cache()
        yield boto3.client("s3", region_name="ap-south-1")
        clear_cache()


def test_hospital_bucket_upload_only_role(env, aws, monkeypatch):
    import requests
    import test_upload_flow

    api, c = env["platform"], env["client"]
    original_put = test_upload_flow.put

    def put(api_, url, data):
        if url.startswith("http://testserver"):
            return original_put(api_, url, data)
        r = requests.put(url, data=data, timeout=10)
        r.headers["ETag"] = r.headers.get("ETag", "")
        return r

    monkeypatch.setattr(test_upload_flow, "put", put)
    from app.config import get_settings as platform_settings

    monkeypatch.setattr(
        platform_settings(), "part_size", 8 * 1024 * 1024
    )  # S3: parts >= 5 MiB except the last
    settings = api.get("/hospital/storage", headers=hdr(env["admin_tok"])).json()
    ext = settings["external_id"]
    assert settings["kind"] == "managed" and ext.startswith("nc-")
    assert settings["trust_policy"]["Statement"][0]["Condition"]["StringEquals"]["sts:ExternalId"] == ext

    bad = api.put(
        "/hospital/storage",
        headers=hdr(env["admin_tok"]),
        json={
            "kind": "s3",
            "s3": {
                "bucket": "no-such-bucket",
                "region": "ap-south-1",
                "role_arn": "arn:aws:iam::123456789012:role/nc-upload",
            },
        },
    )
    assert bad.status_code == 422 and bad.json()["detail"]["upload"] == "fail"
    assert api.get("/hospital/storage", headers=hdr(env["admin_tok"])).json()["kind"] == "managed"

    r = api.put(
        "/hospital/storage",
        headers=hdr(env["admin_tok"]),
        json={
            "kind": "s3",
            "s3": {
                "bucket": "sunrise-recordings",
                "region": "ap-south-1",
                "role_arn": "arn:aws:iam::123456789012:role/nc-upload",
                "prefix": "neurocapture/",
            },
        },
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["kind"] == "s3" and out["check"]["assume_role"] == "pass" and out["check"]["upload"] == "pass"
    assert out["permissions_policy"]["Statement"][0]["Action"] == [
        "s3:PutObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts",
    ]
    assert (
        out["permissions_policy"]["Statement"][0]["Resource"]
        == "arn:aws:s3:::sunrise-recordings/neurocapture/*"
    )

    rotate_take_key()
    ncid, acc, sess = patient_session(env, env["admin_tok"])
    link_ncid(ncid)
    take_id = record(env, acc, sess, "tk-s3")

    # The objects are in the hospital's bucket, under its prefix; nothing in platform storage.
    keys = [o["Key"] for o in aws.list_objects_v2(Bucket="sunrise-recordings").get("Contents", [])]
    assert keys and all(k.startswith(f"neurocapture/{env['site_id']}/") for k in keys)
    from app.storage import get_storage

    assert not list((get_storage().root / "objects").rglob("*.enc"))
    from app.db import _factory
    from app.models import TakeFile

    with _factory()() as db:
        files = db.query(TakeFile).filter(TakeFile.take_id == take_id).all()
        assert {f.checksum_verified for f in files} == {None}  # the platform could not read them

    # The connector reads with the hospital's own credentials, checks SHA-256 and reports it.
    r = c.get(f"/v1/takes/{take_id}/files/video", headers=ctoken(env))
    assert r.status_code == 200 and r.content == b"\x00" * 3000
    with _factory()() as db:
        f = db.query(TakeFile).filter(TakeFile.take_id == take_id, TakeFile.kind == "video").one()
        assert f.checksum_verified is True

    # A file changed in the bucket is reported as a mismatch.
    lm_key = next(k for k in keys if k.endswith("landmarks.enc"))
    aws.put_object(Bucket="sunrise-recordings", Key=lm_key, Body=b"tampered")
    assert c.get(f"/v1/takes/{take_id}/files/landmarks", headers=ctoken(env)).status_code == 502
    with _factory()() as db:
        f = db.query(TakeFile).filter(TakeFile.take_id == take_id, TakeFile.kind == "landmarks").one()
        assert f.checksum_verified is False
