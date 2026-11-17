"""Where a hospital's recordings go (PLATFORM_PLAN M12, decisions 026, 037, 044).

Decision 044: NeuroCapture stores no videos. A hospital records only after it connects its own
storage; until then sessions and takes are refused (`storage_not_connected`).

- none: not connected yet, no recording.
- dev: development storage for tests and the local demo stack (NC_DEV_STORAGE=true only).
- azure: the hospital's own Azure Storage container (decision 037). NeuroCapture's multi-tenant app
  signs in to the hospital's tenant; its role there allows writing blobs only, so the user
  delegation SAS it hands to phones can upload but never read.
- s3: the hospital's own bucket. The platform assumes the hospital's IAM role with the hospital's
  ExternalId and a session policy narrowed to upload actions under the hospital's prefix. It can
  start, sign, list and complete multipart uploads, but cannot read objects back: the hospital's
  connector checks SHA-256 when it first reads a file.

A file's location is snapshotted on the TakeFile when the take is created, so changing a
hospital's storage later does not move or lose earlier uploads.
"""

import json
import threading
import time

import boto3
from botocore.client import Config

from app.config import get_settings
from app.models import Site, TakeFile
from app.storage import S3Storage, Storage, get_storage

UPLOAD_ACTIONS = ["s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]


def session_policy(bucket: str, prefix: str) -> dict:
    return {
        "Version": "2012-10-17",
        "Statement": [
            {"Effect": "Allow", "Action": UPLOAD_ACTIONS, "Resource": f"arn:aws:s3:::{bucket}/{prefix}*"}
        ],
    }


def role_permissions_policy(bucket: str, prefix: str) -> dict:
    """What the hospital attaches to the role (shown in the dashboard)."""
    return session_policy(bucket, prefix)


def role_trust_policy(external_id: str) -> dict:
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Principal": {"AWS": get_settings().platform_aws_principal},
                "Action": "sts:AssumeRole",
                "Condition": {"StringEquals": {"sts:ExternalId": external_id}},
            }
        ],
    }


class HospitalS3Storage(S3Storage):
    readable = False

    def sha256(self, key: str) -> str:
        raise PermissionError("upload-only role: the hospital's connector verifies checksums")

    def read(self, key: str) -> bytes:
        raise PermissionError("upload-only role")

    def size(self, key: str) -> int:
        raise PermissionError("upload-only role")

    def download_url(self, key: str, ttl_s: int) -> str:
        raise PermissionError("upload-only role")


_cache: dict[tuple, tuple[float, object]] = {}
_lock = threading.Lock()


def _assumed_client(cfg: dict, external_id: str):
    """S3 client on temporary credentials for the hospital's role, cached until 5 min before expiry."""
    s = get_settings()
    k = (
        cfg["role_arn"],
        external_id,
        cfg["bucket"],
        cfg.get("prefix", ""),
        cfg.get("region"),
        cfg.get("endpoint"),
    )
    with _lock:
        hit = _cache.get(k)
        if hit and hit[0] > time.time() + 300:
            return hit[1]
    sts = boto3.client(
        "sts",
        endpoint_url=s.sts_endpoint,
        region_name=cfg.get("region") or s.s3_region,
        aws_access_key_id=s.s3_access_key,
        aws_secret_access_key=s.s3_secret_key,
    )
    creds = sts.assume_role(
        RoleArn=cfg["role_arn"],
        RoleSessionName="neurocapture-upload",
        ExternalId=external_id,
        DurationSeconds=3600,
        Policy=json.dumps(session_policy(cfg["bucket"], cfg.get("prefix", ""))),
    )["Credentials"]
    client = boto3.client(
        "s3",
        endpoint_url=cfg.get("endpoint"),
        region_name=cfg.get("region") or s.s3_region,
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"],
        config=Config(signature_version="s3v4"),
    )
    exp = creds["Expiration"].timestamp() if hasattr(creds["Expiration"], "timestamp") else time.time() + 3600
    with _lock:
        _cache[k] = (exp, client)
    return client


def clear_cache() -> None:
    with _lock:
        _cache.clear()
        _azure.clear()


_azure: dict[tuple, object] = {}


def hospital_azure_service(cfg: dict):
    """(BlobServiceClient, account key or None) for a hospital's storage account, signed in as
    NeuroCapture's app in the hospital's tenant. Tests replace this."""
    from azure.identity import ClientSecretCredential
    from azure.storage.blob import BlobServiceClient

    from app.storage.azure import account_url

    s = get_settings()
    if not (s.azure_client_id and s.azure_client_secret):
        raise ValueError("NC_AZURE_CLIENT_ID and NC_AZURE_CLIENT_SECRET are not set")
    cred = ClientSecretCredential(cfg["tenant_id"], s.azure_client_id, s.azure_client_secret)
    return BlobServiceClient(account_url(cfg["account"], cfg.get("endpoint")), credential=cred), None


def _hospital_azure(cfg: dict):
    from app.storage.azure import HospitalAzureStorage

    k = (cfg["account"], cfg["container"], cfg["tenant_id"], cfg.get("endpoint"))
    with _lock:
        hit = _azure.get(k)
    if hit:
        return hit
    service, key = hospital_azure_service(cfg)
    st = HospitalAzureStorage(service, cfg["container"], get_settings().upload_url_ttl_s, key)
    with _lock:
        _azure[k] = st
    return st


def can_record(site: Site) -> bool:
    """Decision 044: the hospital's own storage is connected and its last test passed."""
    if site.storage_kind == "dev":
        return get_settings().dev_storage
    if site.storage_kind in ("s3", "azure") and site.storage_config:
        return (site.storage_check or {}).get("upload") == "pass"
    return False


def location_for(site: Site) -> dict | None:
    """Location snapshot for new files of this hospital (None = development storage)."""
    if site.storage_kind == "s3" and site.storage_config and site.storage_external_id:
        return {"kind": "s3", **site.storage_config, "external_id": site.storage_external_id}
    if site.storage_kind == "azure" and site.storage_config:
        return {"kind": "azure", **site.storage_config}
    if site.storage_kind == "dev" and get_settings().dev_storage:
        return None
    raise StorageNotConnectedError()


class StorageNotConnectedError(RuntimeError):
    """The hospital has not connected its own storage (decision 044)."""


def storage_at(location: dict | None) -> Storage:
    s = get_settings()
    if location is None:
        if not s.dev_storage:
            raise StorageNotConnectedError()
        return get_storage()
    if location["kind"] == "s3":
        client = _assumed_client(location, location["external_id"])
        return HospitalS3Storage(client, location["bucket"], s.upload_url_ttl_s, location.get("kms_key_id"))
    if location["kind"] == "azure":
        return _hospital_azure(location)
    raise ValueError(f"unknown storage kind {location['kind']!r}")


def storage_of(f: TakeFile) -> Storage:
    return storage_at(f.location)


def object_key(site: Site, session_id: str, take_id: str, kind: str) -> str:
    prefix = (site.storage_config or {}).get("prefix", "") if site.storage_kind in ("s3", "azure") else ""
    return f"{prefix}{site.id}/{session_id}/{take_id}/{kind}.enc"
