"""M11 platform side: connector registration, connector tokens, signed download links, signatures."""

import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from test_tenancy import _clean, hdr, onboard, platform, sign_up  # noqa: F401 - fixtures

from app.signing import NonceCache, platform_key, public_pem, sign_headers, verify_signed


@pytest.fixture
def hosp(api, platform):  # noqa: F811
    site = onboard(api, platform, "Sunrise Neuro Clinic", "admin@sunrise.example")
    tok, _ = sign_up(api, "admin@sunrise.example")
    return site, tok


def test_register_connector_and_token(api, hosp):
    site, tok = hosp
    assert api.post("/hospital/connector-token", headers=hdr(tok)).status_code == 409
    bad = api.put(
        "/hospital/connector", headers=hdr(tok), json={"url": "https://c.example", "public_key_pem": "x" * 50}
    )
    assert bad.status_code == 422
    key = Ed25519PrivateKey.generate()
    r = api.put(
        "/hospital/connector",
        headers=hdr(tok),
        json={"url": "https://c.example/", "public_key_pem": public_pem(key.public_key())},
    )
    assert r.status_code == 200 and r.json()["registered"] and r.json()["url"] == "https://c.example"
    t = api.post("/hospital/connector-token", headers=hdr(tok)).json()
    claims = jwt.decode(
        t["token"],
        platform_key().public_key(),
        algorithms=["EdDSA"],
        audience=f"site:{site}",
        issuer="neurocapture",
    )
    assert claims["role"] == "hospital_admin" and claims["typ"] == "connector" and t["expires_in"] == 600
    pk = api.get("/.well-known/neurocapture-platform-key").json()
    assert pk["algorithm"] == "Ed25519" and "BEGIN PUBLIC KEY" in pk["public_key_pem"]


def test_unreachable_connector_check_fails_cleanly(api, hosp, monkeypatch):
    import httpx

    from app.api import connector_link

    _, tok = hosp
    key = Ed25519PrivateKey.generate()
    api.put(
        "/hospital/connector",
        headers=hdr(tok),
        json={"url": "https://c.example", "public_key_pem": public_pem(key.public_key())},
    )

    def down(request):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(connector_link, "CONNECTOR_CLIENT", httpx.Client(transport=httpx.MockTransport(down)))
    r = api.post("/hospital/connector/check", headers=hdr(tok), json={})
    assert r.json()["check"]["reachable"] == "fail" and r.json()["check"]["records"] == "fail"


def test_signed_requests():
    key = Ed25519PrivateKey.generate()
    h = {k.lower(): v for k, v in sign_headers(key, "s1", "POST", "/a?b=1", b"{}").items()}
    n = NonceCache()
    assert verify_signed(key.public_key(), "POST", "/a?b=1", h, b"{}", 300, n)
    assert not verify_signed(key.public_key(), "POST", "/a?b=1", h, b"{}", 300, n)  # replay
    h2 = {k.lower(): v for k, v in sign_headers(key, "s1", "POST", "/a", b"{}").items()}
    assert not verify_signed(key.public_key(), "POST", "/a", h2, b"{ }", 300, NonceCache())  # body changed
    assert not verify_signed(key.public_key(), "GET", "/a", h2, b"{}", 300, NonceCache())  # method changed
    assert not verify_signed(
        Ed25519PrivateKey.generate().public_key(), "POST", "/a", h2, b"{}", 300, NonceCache()
    )
    old = {**h2, "x-nc-timestamp": str(int(time.time()) - 1000)}
    assert not verify_signed(key.public_key(), "POST", "/a", old, b"{}", 300, NonceCache())


def test_local_download_links(api):
    from app.storage import get_storage

    st = get_storage()
    path = st.root / "objects" / "s1/x/y/video.enc"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"cipher")
    url = st.download_url("s1/x/y/video.enc", 60).replace("http://testserver", "")
    assert api.get(url).content == b"cipher"
    assert api.get(url.replace("sig=", "sig=0")).status_code == 403
    assert api.get(url.replace("video.enc", "other.enc")).status_code == 403
