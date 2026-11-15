"""Decision 027: the connector never trusts a platform key it fetched unless its SHA-256 is pinned."""

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from ncconnector import keys
from ncconnector.config import get_settings


@pytest.fixture
def fetch(monkeypatch):
    real = Ed25519PrivateKey.generate().public_key()
    monkeypatch.setattr(keys, "PLATFORM_KEY_OVERRIDE", None)
    keys._platform_key_from_config.cache_clear()
    served = {"pem": keys.public_pem(real)}
    monkeypatch.setattr(
        httpx, "get", lambda url, timeout: httpx.Response(200, json={"public_key_pem": served["pem"]})
    )
    yield real, served
    keys._platform_key_from_config.cache_clear()


def test_no_pin_no_trust(fetch, monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "platform_public_key_path", None)
    monkeypatch.setattr(s, "platform_key_sha256", None)
    with pytest.raises(RuntimeError):
        keys.platform_public_key()


def test_pinned_fetch(fetch, monkeypatch):
    real, served = fetch
    s = get_settings()
    monkeypatch.setattr(s, "platform_public_key_path", None)
    monkeypatch.setattr(s, "platform_key_sha256", keys.key_sha256(real))
    assert keys.key_sha256(keys.platform_public_key()) == keys.key_sha256(real)
    # A swapped key (e.g. a spoofed platform) is refused.
    keys._platform_key_from_config.cache_clear()
    served["pem"] = keys.public_pem(Ed25519PrivateKey.generate().public_key())
    with pytest.raises(ValueError):
        keys.platform_public_key()
