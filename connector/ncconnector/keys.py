"""Connector keys: its Ed25519 signing key, the platform's public key, the hospital take key."""

import logging
from functools import lru_cache
from pathlib import Path

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from ncconnector.config import get_settings

log = logging.getLogger("ncconnector.keys")


def generate_signing_key(path: str) -> str:
    """Writes a new Ed25519 private key (mode 600) and returns the public key PEM to register."""
    key = Ed25519PrivateKey.generate()
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    p = Path(path)
    p.write_bytes(pem)
    p.chmod(0o600)
    return public_pem(key.public_key())


def public_pem(key: Ed25519PublicKey) -> str:
    return key.public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()


@lru_cache
def signing_key() -> Ed25519PrivateKey:
    path = get_settings().signing_key_path
    if path:
        key = serialization.load_pem_private_key(Path(path).read_bytes(), password=None)
        if not isinstance(key, Ed25519PrivateKey):
            raise ValueError("NCC_SIGNING_KEY_PATH must be an Ed25519 key")
        return key
    log.warning("no NCC_SIGNING_KEY_PATH: using an ephemeral signing key (dev only)")
    return Ed25519PrivateKey.generate()


#: Tests set this to the platform's key; otherwise it is read from a file or the platform.
PLATFORM_KEY_OVERRIDE: Ed25519PublicKey | None = None


@lru_cache
def _platform_key_from_config() -> Ed25519PublicKey:
    s = get_settings()
    if s.platform_public_key_path:
        pem = Path(s.platform_public_key_path).read_text()
    else:
        pem = httpx.get(f"{s.platform_url}/.well-known/neurocapture-platform-key", timeout=10).json()[
            "public_key_pem"
        ]
    key = serialization.load_pem_public_key(pem.encode())
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError("platform key must be Ed25519")
    return key


def platform_public_key() -> Ed25519PublicKey:
    return PLATFORM_KEY_OVERRIDE or _platform_key_from_config()


#: Tests: legacy platform key used for pre-M12 recordings.
TAKE_KEY_OVERRIDE: rsa.RSAPrivateKey | None = None


@lru_cache
def _legacy_take_key() -> rsa.RSAPrivateKey | None:
    path = get_settings().take_private_key_path
    if not path:
        return None
    key = serialization.load_pem_private_key(Path(path).read_bytes(), password=None)
    return key if isinstance(key, rsa.RSAPrivateKey) else None


def _keyring() -> Path:
    return Path(get_settings().take_keys_dir)


def keyring_ids() -> list[str]:
    d = _keyring()
    return sorted(p.stem for p in d.glob("hk-*.pem")) if d.is_dir() else []


def take_private_key(key_id: str | None = None) -> rsa.RSAPrivateKey | None:
    """Hospital key `key_id` from the keyring; for other IDs (pre-M12) the legacy platform key."""
    if key_id and key_id.startswith("hk-"):
        p = _keyring() / f"{key_id}.pem"
        if not p.is_file() or "/" in key_id:
            return None
        key = serialization.load_pem_private_key(p.read_bytes(), password=None)
        return key if isinstance(key, rsa.RSAPrivateKey) else None
    return TAKE_KEY_OVERRIDE or _legacy_take_key()


def has_take_key() -> bool:
    return bool(keyring_ids()) or (TAKE_KEY_OVERRIDE or _legacy_take_key()) is not None


def rotate_take_key(bits: int = 3072) -> dict:
    """New RSA take key: registered with the platform first, then saved as <key_id>.pem (0600).
    The private key never leaves this machine; the previous key is retired but kept."""
    from ncconnector import platform

    key = rsa.generate_private_key(public_exponent=65537, key_size=bits)
    pub = key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    d = _keyring()
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / ".pending.pem"
    tmp.write_bytes(pem)
    tmp.chmod(0o600)
    try:
        out = platform.call("POST", "/connector/v1/keys", {"public_key_pem": pub.decode()})
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    tmp.rename(d / f"{out['key_id']}.pem")
    return out
