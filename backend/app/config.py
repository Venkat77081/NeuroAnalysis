from functools import lru_cache

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


@lru_cache
def get_settings() -> Settings:
    return Settings()
