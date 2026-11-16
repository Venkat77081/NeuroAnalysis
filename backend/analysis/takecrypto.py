"""Decrypt an uploaded take on the server (DEV_PLAN §14, decision 020).

The phone uploads each file as stored: Tink streaming AEAD (AES256_GCM_HKDF_4KB) under a per-take
data key. The data key travels as a binary Tink keyset wrapped with the server's RSA-OAEP key
(SHA-256, MGF1-SHA-256, no label). Associated data binds each file to its take and name:
"nc-file-v1:<client take id>/<file name>".
"""

from __future__ import annotations

import base64
import io

import tink
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from tink import secret_key_access, streaming_aead

streaming_aead.register()

#: take_files.kind → file name on the phone (VaultTakeFiles.KINDS).
FILE_NAMES = {
    "video": "video.mp4",
    "frames": "frames.bin",
    "landmarks": "landmarks.bin",
    "sensors": "sensors.bin",
    "quality": "quality.json",
    "meta": "meta.json",
}

_OAEP = padding.OAEP(mgf=padding.MGF1(algorithm=hashes.SHA256()), algorithm=hashes.SHA256(), label=None)


def unwrap_data_key(wrapped_b64: str, private_key: rsa.RSAPrivateKey) -> bytes:
    return private_key.decrypt(base64.b64decode(wrapped_b64), _OAEP)


def wrap_data_key(keyset: bytes, public_key: rsa.RSAPublicKey) -> str:
    """What the phone does (KeyWrap.kt); used by tests and tools."""
    return base64.b64encode(public_key.encrypt(keyset, _OAEP)).decode()


def _primitive(keyset: bytes) -> streaming_aead.StreamingAead:
    handle = tink.proto_keyset_format.parse(keyset, secret_key_access.TOKEN)
    return handle.primitive(streaming_aead.StreamingAead)


def _ad(client_take_id: str, kind: str) -> bytes:
    return f"nc-file-v1:{client_take_id}/{FILE_NAMES[kind]}".encode()


def decrypt_file(keyset: bytes, client_take_id: str, kind: str, ciphertext: bytes) -> bytes:
    with _primitive(keyset).new_decrypting_stream(io.BytesIO(ciphertext), _ad(client_take_id, kind)) as s:
        return s.read()


def encrypt_file(keyset: bytes, client_take_id: str, kind: str, plaintext: bytes) -> bytes:
    """What the phone does (TakeVault.openEncrypting); used by tests and tools."""
    out = io.BytesIO()
    stream = _primitive(keyset).new_encrypting_stream(_NoClose(out), _ad(client_take_id, kind))
    stream.write(plaintext)
    stream.close()
    return out.getvalue()


def new_data_keyset() -> bytes:
    handle = tink.new_keyset_handle(streaming_aead.streaming_aead_key_templates.AES256_GCM_HKDF_4KB)
    return tink.proto_keyset_format.serialize(handle, secret_key_access.TOKEN)


class _NoClose(io.RawIOBase):
    """Keeps the BytesIO readable after Tink closes the stream."""

    def __init__(self, inner: io.BytesIO):
        self.inner = inner

    def writable(self) -> bool:
        return True

    def write(self, b) -> int:
        return self.inner.write(b)
