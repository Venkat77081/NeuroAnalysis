"""Database models (DEV_PLAN §13.1). No patient names anywhere; identifiers are hashed on the device."""

from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

Json = JSON().with_variant(JSONB(), "postgresql")


def now() -> datetime:
    return datetime.now(UTC)


def new_id() -> str:
    return uuid4().hex


class Base(DeclarativeBase):
    pass


class Site(Base):
    __tablename__ = "sites"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200))
    region: Mapped[str] = mapped_column(String(50))
    #: SHA-256 of the enrollment code given to the site for registering phones.
    enrollment_code_hash: Mapped[str] = mapped_column(String(64), unique=True)
    #: Salt the device uses to hash patient references before they leave the phone.
    patient_ref_salt: Mapped[str] = mapped_column(String(64))


class Operator(Base):
    __tablename__ = "operators"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"))
    #: Operator code typed at login (e.g. OP-07); not a name.
    code: Mapped[str] = mapped_column(String(20))
    display_name_hash: Mapped[str | None] = mapped_column(String(64))
    pin_hash: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(20), default="operator")  # operator | reviewer | admin
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    __table_args__ = (UniqueConstraint("site_id", "code"),)


class Device(Base):
    __tablename__ = "devices"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"))
    model: Mapped[str] = mapped_column(String(100))
    os_version: Mapped[str] = mapped_column(String(50))
    tier: Mapped[str | None] = mapped_column(String(1))
    qualification_report: Mapped[dict | None] = mapped_column(Json)
    secret_hash: Mapped[str] = mapped_column(String(64))
    registered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    operator_id: Mapped[str] = mapped_column(ForeignKey("operators.id"))
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)


class Patient(Base):
    __tablename__ = "patients"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"))
    external_ref_hash: Mapped[str] = mapped_column(String(64))
    year_of_birth: Mapped[int | None] = mapped_column(Integer)
    sex: Mapped[str | None] = mapped_column(String(1))
    __table_args__ = (UniqueConstraint("site_id", "external_ref_hash"),)


class Session(Base):
    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    #: Session ID generated on the phone (idempotent creation).
    client_session_id: Mapped[str] = mapped_column(String(64))
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"))
    operator_id: Mapped[str] = mapped_column(ForeignKey("operators.id"))
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    aborted: Mapped[dict | None] = mapped_column(Json)
    med_state: Mapped[str] = mapped_column(String(3))
    app_version: Mapped[str] = mapped_column(String(20))
    config_versions: Mapped[dict] = mapped_column(Json)
    consent_version: Mapped[str] = mapped_column(String(50))
    consent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    __table_args__ = (UniqueConstraint("device_id", "client_session_id"),)


class Take(Base):
    __tablename__ = "takes"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    client_take_id: Mapped[str] = mapped_column(String(64))
    session_id: Mapped[str] = mapped_column(ForeignKey("sessions.id"))
    test_code: Mapped[str] = mapped_column(String(3))
    side: Mapped[str | None] = mapped_column(String(1))
    take_no: Mapped[int] = mapped_column(Integer)
    capture_verdict: Mapped[str] = mapped_column(String(8))
    override_reason: Mapped[str | None] = mapped_column(String(50))
    flagged_for_review: Mapped[bool] = mapped_column(Boolean, default=False)
    quality: Mapped[dict] = mapped_column(Json)
    meta: Mapped[dict] = mapped_column(Json)
    #: Take data key wrapped with the server RSA-OAEP public key (base64) and that key's ID (§14).
    wrapped_data_key: Mapped[str] = mapped_column(String(1024))
    key_id: Mapped[str] = mapped_column(String(50))
    status: Mapped[str] = mapped_column(String(10), default="pending")  # pending|uploading|complete|failed
    checksums: Mapped[dict] = mapped_column(Json, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (UniqueConstraint("session_id", "client_take_id"),)


class TakeFile(Base):
    __tablename__ = "take_files"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    take_id: Mapped[str] = mapped_column(ForeignKey("takes.id"))
    kind: Mapped[str] = mapped_column(String(10))  # video|frames|landmarks|sensors|quality|meta
    object_key: Mapped[str] = mapped_column(String(300))
    upload_id: Mapped[str | None] = mapped_column(String(300))
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (UniqueConstraint("take_id", "kind"),)


class BiomarkerRun(Base):
    """Biomarker readiness (M8) and, later, biomarker results for one take (§13.1)."""

    __tablename__ = "biomarker_runs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    take_id: Mapped[str] = mapped_column(ForeignKey("takes.id"), index=True)
    registry_version: Mapped[str] = mapped_column(String(20))
    #: server = recomputed from the decrypted files; device_hint = the phone's hint (no key here)
    source: Mapped[str] = mapped_column(String(12))
    status: Mapped[str] = mapped_column(String(10))  # ready | error
    readiness: Mapped[dict] = mapped_column(Json)
    results: Mapped[dict | None] = mapped_column(Json)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    actor_id: Mapped[str | None] = mapped_column(String(32))
    actor_type: Mapped[str] = mapped_column(String(20))  # operator | device | system
    action: Mapped[str] = mapped_column(String(50))
    target_type: Mapped[str | None] = mapped_column(String(20))
    target_id: Mapped[str | None] = mapped_column(String(32))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    details: Mapped[dict | None] = mapped_column(Json)
