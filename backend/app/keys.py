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
def server_public_key() -> tuple[str, str]:
    """(key_id, PEM) of the current wrapping key."""
    s = get_settings()
    if s.server_public_key_path:
        return s.server_key_id, Path(s.server_public_key_path).read_text()
    log.warning("no NC_SERVER_PUBLIC_KEY_PATH: using an ephemeral dev key")
    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    pem = key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return f"{s.server_key_id}-ephemeral", pem.decode()
