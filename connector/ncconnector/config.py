from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment variables prefixed NCC_ (docs/connector.md)."""

    model_config = SettingsConfigDict(env_prefix="NCC_", env_file=".env", extra="ignore")

    #: The hospital's site ID on the platform (shown in the hospital dashboard).
    site_id: str = "dev-site"
    platform_url: str = "http://localhost:8000"
    #: Platform Ed25519 public key (PEM file), or its SHA-256 (shown in the hospital dashboard) to
    #: pin a key fetched from the platform. One of the two is required: a fetched key is never
    #: trusted on its own (decision 027).
    platform_public_key_path: str | None = None
    platform_key_sha256: str | None = None
    #: This connector's Ed25519 private key (python -m ncconnector keygen). Dev: ephemeral.
    signing_key_path: str | None = None
    #: M12: directory of the hospital's RSA take keys, one "<key_id>.pem" per key (python -m
    #: ncconnector rotate-take-key). Old keys stay for earlier recordings.
    take_keys_dir: str = "./take-keys"
    #: Pre-M12 recordings: the platform key the phones used (optional, legacy).
    take_private_key_path: str | None = None
    #: The hospital's own bucket (M12, storage "s3"): read with the connector's own AWS credentials
    #: (standard AWS environment / instance role). Endpoint only for S3-compatible stores.
    s3_endpoint: str | None = None
    s3_region: str = "ap-south-1"
    #: The hospital's own Azure Blob container (decision 037): read with the connector's identity:
    #: the VM's managed identity or AZURE_CLIENT_ID/AZURE_TENANT_ID/AZURE_CLIENT_SECRET (needs the
    #: "Storage Blob Data Reader" role), or this storage account key.
    azure_storage_key: str | None = None

    #: The connector's own database: NCID <-> MRN map, clinical activity log, log spool.
    database_url: str = "sqlite+pysqlite:///./connector.db"

    #: Where patient records are read live: fhir | sql
    records: str = "fhir"
    fhir_base_url: str = "http://localhost:8080/fhir"
    #: FHIR identifier system that holds the MRN, e.g. "urn:oid:..." or the hospital's URL.
    fhir_mrn_system: str = "urn:neurocapture:mrn"
    fhir_bearer_token: str | None = None
    #: Read-only database URL with the views in sql/sample_views.sql.
    records_sql_url: str | None = None
    records_timeout_s: float = 5.0

    #: Clinical activity log sink: db (table in this connector's database) | http (log server).
    activity_sink: str = "db"
    activity_http_url: str | None = None

    #: Message delivery (backend/app/delivery.py, identical in the connector). "dummy" keeps messages
    #: in memory and sends nothing (dev, tests).
    email_provider: str = "dummy"  # dummy | smtp
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_security: str = "starttls"  # starttls (587) | ssl (465) | none (trusted relay, 25)
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_timeout_s: float = 15.0
    mail_from: str | None = None
    mail_from_name: str | None = None
    mail_reply_to: str | None = None
    sms_provider: str = "dummy"  # dummy | twilio | sns | http
    #: Twilio "From" number, or the sender ID for SNS / the HTTP gateway (e.g. a DLT header).
    sms_from: str | None = None
    #: Added to numbers in the records that have no country code.
    sms_default_country_code: str = "+91"
    sms_timeout_s: float = 15.0
    #: India (TRAI DLT): the principal entity ID and, per message, the registered template ID, as
    #: JSON: {"patientInviteSms": "1207...", "reminderSms": "1207..."}.
    sms_dlt_entity_id: str | None = None
    sms_dlt_template_ids: str | None = None
    twilio_account_sid: str | None = None
    twilio_auth_token: str | None = None
    twilio_messaging_service_sid: str | None = None
    sms_aws_region: str = "ap-south-1"
    sms_http_url: str | None = None
    sms_http_token: str | None = None
    hospital_name: str = "Hospital"
    #: Dashboard origin(s) allowed to call this connector from the browser (CORS), comma-separated.
    #: Includes the Android app's WebView origin (clinic phones look up NCIDs).
    cors_origins: str = "http://localhost:5174,https://localhost"
    signature_window_s: int = 300
    #: v3: how often due recording reminders are sent (0 = off; then use the CLI).
    reminder_interval_s: int = 900
    #: v29 (decision 052): how often the connector checks in with the platform (0 = off). Keep
    #: it at or below the platform's connectorHealth.heartbeatSeconds (config/platform.json).
    heartbeat_interval_s: int = 300
    message_lang: str = "en"


@lru_cache
def get_settings() -> Settings:
    return Settings()
