from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuration from environment variables prefixed NC_ (see docker-compose.yml)."""

    model_config = SettingsConfigDict(env_prefix="NC_", env_file=".env", extra="ignore")

    database_url: str = "sqlite+pysqlite:///:memory:"
    # Object storage: "local" (files under storage_dir, signed URLs served by this API — dev, CI,
    # single-server pilots) or "s3" (presigned multipart on S3; production). Decision 019.
    storage: str = "local"
    storage_dir: str = "/tmp/neurocapture-storage"  # noqa: S108 - dev default; set NC_STORAGE_DIR
    public_base_url: str = "http://localhost:8000"
    s3_endpoint: str | None = None
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_bucket: str = "neurocapture-takes"
    s3_region: str = "ap-south-1"
    health_timeout_s: float = 2.0
    # Auth (§13.2): JWT per operator, bound to a registered device.
    jwt_secret: str = "dev-only-change-me"  # noqa: S105 - must be set in production
    access_ttl_s: int = 900
    refresh_ttl_s: int = 30 * 24 * 3600
    # Uploads
    part_size: int = 8 * 1024 * 1024
    upload_url_ttl_s: int = 3600
    # Server RSA-OAEP public key that wraps each take's data key (§14). PEM file and key ID.
    server_key_id: str = "dev-key-1"
    server_public_key_path: str | None = None
    # Its private key, for server-side readiness (M8). Dev/pilot only: production keeps it in the
    # KMS (decision 020). Without it, readiness falls back to the phone's hint (source device_hint).
    server_private_key_path: str | None = None
    # M10 providers. "dummy" keeps messages in memory (dev, tests) until real ones are configured.
    email_provider: str = "dummy"
    sms_provider: str = "dummy"
    #: Link the patient app opens from an invite (QR code / e-mail / SMS); the token follows.
    invite_link_base: str = "neurocapture://invite?t="
    #: Web dashboard address used in staff invite e-mails.
    dashboard_url: str = "http://localhost:5174"
    # M11: Ed25519 key the platform signs connector requests and connector tokens with. Dev/tests:
    # ephemeral (connectors must re-fetch the public key after a restart).
    platform_signing_key_path: str | None = None
    platform_key_id: str = "platform-1"
    connector_token_ttl_s: int = 600
    connector_timeout_s: float = 10.0
    #: Signed request clock window (seconds).
    signature_window_s: int = 300
    # M12: per-hospital storage. Managed hospitals on S3 get their own bucket from this template
    # ("{bucket}" = one shared bucket with a per-hospital prefix; e.g. "nc-managed-{site}").
    managed_bucket_template: str = "{bucket}"
    #: STS endpoint (None = AWS default) and the AWS principal hospitals trust in their role policy.
    sts_endpoint: str | None = None
    platform_aws_principal: str = "arn:aws:iam::000000000000:root"
    #: Minimum RSA size for hospital take keys.
    min_take_key_bits: int = 3072
    #: Every hospital must have a registered take key before sessions can start (decision 027).
    #: False only for development and the pre-M12 tests.
    require_hospital_key: bool = True
    #: Pre-M10 phones identified patients by SHA-256(site salt + MRN). Off: operators must use an
    #: NCID from the hospital connector (decision 027). True only for the pre-M13 tests.
    allow_legacy_ref_hash: bool = False
    # Repo config/ (test configs, quality.json, biomarker-registry.json, platform.json and
    # messages/). Docker: mounted read-only.
    config_dir: str = str(Path(__file__).resolve().parents[2] / "config")


@lru_cache
def get_settings() -> Settings:
    return Settings()
