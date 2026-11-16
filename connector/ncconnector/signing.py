"""Ed25519 request signing, identical to backend/app/signing.py (contracts/connector-api.yaml)."""

import base64
import hashlib
import secrets
import time
from collections import OrderedDict

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey


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
