"""Object storage for take files (DEV_PLAN §13.2, decision 019).

Both backends speak the same protocol to the phone: create a multipart upload, PUT each part to a
URL from the server, report the part ETags, and the server assembles the object and verifies its
SHA-256. "s3" uses presigned S3 multipart URLs; "local" stores parts on disk behind HMAC-signed
URLs served by this API (dev, CI, single-server pilots).
"""

import hashlib
import hmac
import shutil
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Protocol
from uuid import uuid4

import boto3
from botocore.client import Config

from app.config import get_settings


@dataclass
class Part:
    number: int
    etag: str
    size: int


class Storage(Protocol):
    def create_upload(self, key: str) -> str: ...
    def part_url(self, key: str, upload_id: str, number: int) -> str: ...
    def list_parts(self, key: str, upload_id: str) -> list[Part]: ...
    def complete(self, key: str, upload_id: str, parts: list[Part]) -> None: ...
    def abort(self, key: str, upload_id: str) -> None: ...
    def sha256(self, key: str) -> str: ...
    def size(self, key: str) -> int: ...
    def read(self, key: str) -> bytes: ...


def _safe(name: str) -> str:
    if not name or "/" in name or name.startswith(".") or "\\" in name:
        raise ValueError("bad name")
    return name


class LocalStorage:
    def __init__(self, root: str, base_url: str, secret: str, ttl_s: int):
        self.root = Path(root)
        self.base = base_url.rstrip("/")
        self.secret = secret.encode()
        self.ttl_s = ttl_s
        (self.root / "uploads").mkdir(parents=True, exist_ok=True)
        (self.root / "objects").mkdir(parents=True, exist_ok=True)

    def _sig(self, upload_id: str, number: int, exp: int) -> str:
        msg = f"{upload_id}:{number}:{exp}".encode()
        return hmac.new(self.secret, msg, hashlib.sha256).hexdigest()

    def verify(self, upload_id: str, number: int, exp: int, sig: str) -> bool:
        return exp >= int(time.time()) and hmac.compare_digest(self._sig(upload_id, number, exp), sig)

    def create_upload(self, key: str) -> str:
        upload_id = uuid4().hex
        d = self.root / "uploads" / upload_id
        d.mkdir()
        (d / "_key").write_text(key)
        return upload_id

    def part_url(self, key: str, upload_id: str, number: int) -> str:
        exp = int(time.time()) + self.ttl_s
        sig = self._sig(upload_id, number, exp)
        return f"{self.base}/storage/upload/{upload_id}/{number}?exp={exp}&sig={sig}"

    def write_part(self, upload_id: str, number: int, data: bytes) -> str:
        d = self.root / "uploads" / _safe(upload_id)
        if not d.is_dir():
            raise FileNotFoundError(upload_id)
        (d / f"{number:05d}").write_bytes(data)
        return hashlib.md5(data, usedforsecurity=False).hexdigest()

    def list_parts(self, key: str, upload_id: str) -> list[Part]:
        d = self.root / "uploads" / _safe(upload_id)
        if not d.is_dir():
            return []
        out = []
        for f in sorted(d.iterdir()):
            if f.name.startswith("_"):
                continue
            data = f.read_bytes()
            out.append(Part(int(f.name), hashlib.md5(data, usedforsecurity=False).hexdigest(), len(data)))
        return out

    def _object(self, key: str) -> Path:
        p = self.root / "objects" / key
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def complete(self, key: str, upload_id: str, parts: list[Part]) -> None:
        have = {p.number: p for p in self.list_parts(key, upload_id)}
        d = self.root / "uploads" / _safe(upload_id)
        with self._object(key).open("wb") as out:
            for p in sorted(parts, key=lambda x: x.number):
                got = have.get(p.number)
                if not got or got.etag != p.etag.strip('"'):
                    raise ValueError(f"part {p.number} missing or ETag mismatch")
                out.write((d / f"{p.number:05d}").read_bytes())
        shutil.rmtree(d, ignore_errors=True)

    def abort(self, key: str, upload_id: str) -> None:
        shutil.rmtree(self.root / "uploads" / _safe(upload_id), ignore_errors=True)

    def sha256(self, key: str) -> str:
        h = hashlib.sha256()
        with (self.root / "objects" / key).open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()

    def size(self, key: str) -> int:
        return (self.root / "objects" / key).stat().st_size

    def read(self, key: str) -> bytes:
        return (self.root / "objects" / key).read_bytes()


class S3Storage:
    def __init__(self, client, bucket: str, ttl_s: int):
        self.s3 = client
        self.bucket = bucket
        self.ttl_s = ttl_s

    def create_upload(self, key: str) -> str:
        return self.s3.create_multipart_upload(Bucket=self.bucket, Key=key, ServerSideEncryption="AES256")[
            "UploadId"
        ]

    def part_url(self, key: str, upload_id: str, number: int) -> str:
        return self.s3.generate_presigned_url(
            "upload_part",
            Params={"Bucket": self.bucket, "Key": key, "UploadId": upload_id, "PartNumber": number},
            ExpiresIn=self.ttl_s,
        )

    def list_parts(self, key: str, upload_id: str) -> list[Part]:
        r = self.s3.list_parts(Bucket=self.bucket, Key=key, UploadId=upload_id)
        return [Part(p["PartNumber"], p["ETag"].strip('"'), p["Size"]) for p in r.get("Parts", [])]

    def complete(self, key: str, upload_id: str, parts: list[Part]) -> None:
        self.s3.complete_multipart_upload(
            Bucket=self.bucket,
            Key=key,
            UploadId=upload_id,
            MultipartUpload={
                "Parts": [
                    {"PartNumber": p.number, "ETag": p.etag} for p in sorted(parts, key=lambda x: x.number)
                ]
            },
        )

    def abort(self, key: str, upload_id: str) -> None:
        self.s3.abort_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id)

    def sha256(self, key: str) -> str:
        h = hashlib.sha256()
        body = self.s3.get_object(Bucket=self.bucket, Key=key)["Body"]
        for chunk in iter(lambda: body.read(1 << 20), b""):
            h.update(chunk)
        return h.hexdigest()

    def size(self, key: str) -> int:
        return self.s3.head_object(Bucket=self.bucket, Key=key)["ContentLength"]

    def read(self, key: str) -> bytes:
        return self.s3.get_object(Bucket=self.bucket, Key=key)["Body"].read()


@lru_cache
def get_s3():
    s = get_settings()
    return boto3.client(
        "s3",
        endpoint_url=s.s3_endpoint,
        aws_access_key_id=s.s3_access_key,
        aws_secret_access_key=s.s3_secret_key,
        region_name=s.s3_region,
        config=Config(
            signature_version="s3v4",
            connect_timeout=s.health_timeout_s,
            read_timeout=s.health_timeout_s,
            retries={"max_attempts": 1},
        ),
    )


@lru_cache
def get_storage() -> Storage:
    s = get_settings()
    if s.storage == "s3":
        return S3Storage(get_s3(), s.s3_bucket, s.upload_url_ttl_s)
    return LocalStorage(s.storage_dir, s.public_base_url, s.jwt_secret, s.upload_url_ttl_s)


def ensure_bucket() -> None:
    s3 = get_s3()
    bucket = get_settings().s3_bucket
    existing = {b["Name"] for b in s3.list_buckets().get("Buckets", [])}
    if bucket not in existing:
        s3.create_bucket(Bucket=bucket)


def ping_storage() -> None:
    get_s3().head_bucket(Bucket=get_settings().s3_bucket)


def ping_local_storage() -> None:
    """The local storage directory exists and is writable."""
    root = Path(get_settings().storage_dir)
    root.mkdir(parents=True, exist_ok=True)
    probe = root / ".probe"
    probe.write_text("ok")
    probe.unlink()
