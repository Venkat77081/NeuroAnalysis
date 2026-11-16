"""Server RSA-OAEP public key that wraps each take's data key on the phone (DEV_PLAN §14).

Production: NC_SERVER_PUBLIC_KEY_PATH points to the PEM whose private key lives in the KMS.
Dev/tests: an ephemeral key pair is generated in memory (data uploaded with it cannot be decrypted
after a restart — never use it with real patients)."""

import logging
from functools import lru_cache
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.config import get_settings

log = logging.getLogger("neurocapture.keys")


@lru_cache
def _ephemeral() -> rsa.RSAPrivateKey:
    log.warning("no NC_SERVER_PUBLIC_KEY_PATH: using an ephemeral dev key")
    return rsa.generate_private_key(public_exponent=65537, key_size=3072)


@lru_cache
def server_public_key() -> tuple[str, str]:
    """(key_id, PEM) of the current wrapping key."""
    s = get_settings()
    if s.server_public_key_path:
        return s.server_key_id, Path(s.server_public_key_path).read_text()
    pem = (
        _ephemeral()
        .public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    )
    return f"{s.server_key_id}-ephemeral", pem.decode()


def server_private_key(key_id: str) -> rsa.RSAPrivateKey | None:
    """Private key for `key_id`, if this server may hold it (dev/pilot); None otherwise (KMS)."""
    s = get_settings()
    current_id, _ = server_public_key()
    if key_id != current_id:
        return None  # rotated-out keys live in the KMS only
    if s.server_public_key_path:
        if not s.server_private_key_path:
            return None
        key = serialization.load_pem_private_key(Path(s.server_private_key_path).read_bytes(), password=None)
        return key if isinstance(key, rsa.RSAPrivateKey) else None
    return _ephemeral()
