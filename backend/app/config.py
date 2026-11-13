from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuration from environment variables prefixed NC_ (see docker-compose.yml)."""

    model_config = SettingsConfigDict(env_prefix="NC_", env_file=".env", extra="ignore")

    database_url: str = "sqlite+pysqlite:///:memory:"
    s3_endpoint: str | None = None
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_bucket: str = "neurocapture-takes"
    s3_region: str = "ap-south-1"
    health_timeout_s: float = 2.0


@lru_cache
def get_settings() -> Settings:
    return Settings()
