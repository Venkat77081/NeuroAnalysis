"""Signed requests between the platform and hospital connectors (M11, contracts/connector-api.yaml).

Both directions use Ed25519. The platform holds its private key and stores only each connector's
public key, so no shared secret sits on the platform (PLATFORM_PLAN §4).

A request is signed over:  METHOD \\n PATH?QUERY \\n TIMESTAMP \\n NONCE \\n SHA256(BODY) hex
Headers: X-NC-Key (signer: "platform" or the hospital's site ID), X-NC-Timestamp (unix seconds),
X-NC-Nonce (random, single use within the window), X-NC-Signature (base64url, no padding).
Connector tokens (doctor / hospital admin browser -> connector) are EdDSA JWTs, audience
"site:<id>", signed with the same platform key.
"""

import base64
import hashlib
import logging
import secrets
import time
from collections import OrderedDict
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from pathlib import Path

import jwt
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from app.config import get_settings

log = logging.getLogger("neurocapture.signing")


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def unb64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def canonical(method: str, path: str, ts: str, nonce: str, body: bytes) -> bytes:
    return f"{method.upper()}\n{path}\n{ts}\n{nonce}\n{hashlib.sha256(body).hexdigest()}".encode()


def sign_headers(
    key: Ed25519PrivateKey, signer: str, method: str, path: str, body: bytes = b""
) -> dict[str, str]:
    ts, nonce = str(int(time.time())), secrets.token_hex(16)
    sig = key.sign(canonical(method, path, ts, nonce, body))
    return {"X-NC-Key": signer, "X-NC-Timestamp": ts, "X-NC-Nonce": nonce, "X-NC-Signature": b64u(sig)}


class NonceCache:
    """Remembers nonces for the signature window (replay protection, one process)."""

    def __init__(self, max_items: int = 50_000):
        self._seen: OrderedDict[str, float] = OrderedDict()
        self.max_items = max_items

    def use(self, nonce: str, window_s: int) -> bool:
        now_ = time.time()
        while self._seen and next(iter(self._seen.values())) < now_ - window_s:
            self._seen.popitem(last=False)
        if nonce in self._seen:
            return False
        self._seen[nonce] = now_
        if len(self._seen) > self.max_items:
            self._seen.popitem(last=False)
        return True


NONCES = NonceCache()


class DbNonces:
    """Nonce store in the platform database: one row per nonce, so every API replica sees it."""

    def __init__(self, db, signer: str):
        self.db, self.signer = db, signer

    def use(self, nonce: str, window_s: int) -> bool:
        from sqlalchemy import delete
        from sqlalchemy.exc import IntegrityError

        from app.models import UsedNonce

        cutoff = datetime.now(UTC) - timedelta(seconds=2 * window_s)
        self.db.execute(delete(UsedNonce).where(UsedNonce.seen_at < cutoff))
        try:
            with self.db.begin_nested():
                self.db.add(UsedNonce(nonce=nonce, signer=self.signer))
        except IntegrityError:
            return False
        self.db.commit()
        return True


def verify_signed(
    public: Ed25519PublicKey, method: str, path: str, headers, body: bytes, window_s: int, nonces: NonceCache
) -> bool:
    try:
        ts, nonce, sig = headers["x-nc-timestamp"], headers["x-nc-nonce"], headers["x-nc-signature"]
        if abs(time.time() - int(ts)) > window_s or not 16 <= len(nonce) <= 64:
            return False
        public.verify(unb64u(sig), canonical(method, path, ts, nonce, body))
    except (KeyError, ValueError, InvalidSignature):
        return False
    return nonces.use(nonce, window_s)


def load_public_pem(pem: str) -> Ed25519PublicKey | None:
    try:
        key = serialization.load_pem_public_key(pem.encode())
    except ValueError:
        return None
    return key if isinstance(key, Ed25519PublicKey) else None


def public_pem(key: Ed25519PublicKey) -> str:
    return key.public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()


@lru_cache
def platform_key() -> Ed25519PrivateKey:
    path = get_settings().platform_signing_key_path
    if path:
        key = serialization.load_pem_private_key(Path(path).read_bytes(), password=None)
        if not isinstance(key, Ed25519PrivateKey):
            raise ValueError("platform signing key must be Ed25519")
        return key
    log.warning("no NC_PLATFORM_SIGNING_KEY_PATH: using an ephemeral platform signing key")
    return Ed25519PrivateKey.generate()


def platform_public_pem() -> str:
    return public_pem(platform_key().public_key())


def connector_token(site_id: str, user_id: str, role: str) -> tuple[str, int]:
    ttl = get_settings().connector_token_ttl_s
    now_ = datetime.now(UTC)
    claims = {
        "typ": "connector",
        "iss": "neurocapture",
        "aud": f"site:{site_id}",
        "sub": user_id,
        "role": role,
        "iat": now_,
        "exp": now_ + timedelta(seconds=ttl),
    }
    headers = {"kid": get_settings().platform_key_id}
    return jwt.encode(claims, platform_key(), algorithm="EdDSA", headers=headers), ttl
