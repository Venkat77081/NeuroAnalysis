"""S3-compatible object storage (MinIO in dev). Presigned multipart uploads arrive in M7."""

from functools import lru_cache

import boto3
from botocore.client import Config

from app.config import get_settings


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


def ensure_bucket() -> None:
    s3 = get_s3()
    bucket = get_settings().s3_bucket
    existing = {b["Name"] for b in s3.list_buckets().get("Buckets", [])}
    if bucket not in existing:
        s3.create_bucket(Bucket=bucket)


def ping_storage() -> None:
    get_s3().head_bucket(Bucket=get_settings().s3_bucket)
