"""Database models (DEV_PLAN §13.1, PLATFORM_PLAN M10).

Patients are known only by a random NCID (decision 023): no table holds a patient's name, MRN,
e-mail address or phone number. Staff e-mail addresses (hospital admins, doctors) are stored:
they are accounts, not patient data.
"""

from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
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
    #: Salt the device uses to hash patient references before they leave the phone (pre-M10 app).
    patient_ref_salt: Mapped[str] = mapped_column(String(64))
    # M10: hospital or clinic as a tenant.
    kind: Mapped[str] = mapped_column(String(10), default="hospital")  # hospital | clinic
    #: byo = the hospital's own connector, storage and key; managed = run by NeuroCapture.
    data_mode: Mapped[str] = mapped_column(String(10), default="managed")
    status: Mapped[str] = mapped_column(String(12), default="active")  # invited | active | suspended
    modules: Mapped[dict] = mapped_column(Json, default=dict)  # {"clinic": true, "home": true, ...}
    city: Mapped[str | None] = mapped_column(String(100))
    connector_url: Mapped[str | None] = mapped_column(String(300))
    #: M11: the connector's Ed25519 public key (PEM). Public, not a secret.
    connector_public_key: Mapped[str | None] = mapped_column(Text)
    #: Last health check: {"records": "pass", ...} — pass/fail only, never data.
    connector_check: Mapped[dict | None] = mapped_column(Json)
    connector_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # M12: where this hospital's recordings are stored. managed = NeuroCapture storage, separated
    # per hospital; s3 = the hospital's own bucket through an upload-only role.
    storage_kind: Mapped[str] = mapped_column(String(10), default="managed")
    #: s3: {bucket, region, endpoint?, prefix, role_arn, kms_key_id?}. References only, no secrets.
    storage_config: Mapped[dict | None] = mapped_column(Json)
    #: ExternalId the hospital puts in its role's trust policy (generated here, not a secret).
    storage_external_id: Mapped[str | None] = mapped_column(String(64))
    storage_check: Mapped[dict | None] = mapped_column(Json)
    storage_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sms_enabled: Mapped[bool] = mapped_column(Boolean, default=False)  # hospital pays for SMS
    onboarded_by: Mapped[str | None] = mapped_column(String(32))
    onboarded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Operator(Base):
    __tablename__ = "operators"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"))
    #: Operator code typed at login (e.g. OP-07); not a name.
    code: Mapped[str] = mapped_column(String(20))
    display_name_hash: Mapped[str | None] = mapped_column(String(64))
    #: Password hash (M10: operator ID + password; earlier operators used a PIN, same hash format).
    pin_hash: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(20), default="operator")  # operator | reviewer | admin
    #: Set by a hospital admin's reset: the operator must choose a new password at next sign-in.
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
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
    #: clinic = registered by the hospital (operator mode only); patient = a patient's own phone.
    kind: Mapped[str] = mapped_column(String(10), default="clinic")
    label: Mapped[str | None] = mapped_column(String(60))
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
    #: The only patient key NeuroCapture holds (decision 023); the hospital maps it to the MRN.
    ncid: Mapped[str] = mapped_column(String(40), unique=True, default=lambda: "nc_" + uuid4().hex)
    #: Pre-M10 phones sent a salted hash of the clinic reference; kept for those sessions only.
    external_ref_hash: Mapped[str | None] = mapped_column(String(64))
    year_of_birth: Mapped[int | None] = mapped_column(Integer)
    sex: Mapped[str | None] = mapped_column(String(1))
    __table_args__ = (UniqueConstraint("site_id", "external_ref_hash"),)


class Session(Base):
    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    #: Session ID generated on the phone (idempotent creation).
    client_session_id: Mapped[str] = mapped_column(String(64))
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"))
    #: Clinic sessions: the operator. Home sessions (patient app): null.
    operator_id: Mapped[str | None] = mapped_column(ForeignKey("operators.id"))
    recorded_by: Mapped[str] = mapped_column(String(10), default="operator")  # operator | patient
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    aborted: Mapped[dict | None] = mapped_column(Json)
    med_state: Mapped[str] = mapped_column(String(3))
    app_version: Mapped[str] = mapped_column(String(20))
    config_versions: Mapped[dict] = mapped_column(Json)
    consent_version: Mapped[str] = mapped_column(String(50))
    consent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    #: M12: the hospital key the phone must wrap this session's take keys with (null = pre-M12).
    key_id: Mapped[str | None] = mapped_column(String(50))
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
    #: M12: where the object lives (null = platform storage). Snapshot taken when the take is created.
    location: Mapped[dict | None] = mapped_column(Json)
    #: SHA-256 checked: True/False; None = not yet (hospital bucket: the connector checks on first read).
    checksum_verified: Mapped[bool | None] = mapped_column(Boolean)
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


class SiteKey(Base):
    """A hospital's RSA public key for wrapping take data keys (M12). The private key stays with the
    hospital's connector (or KMS). One active key per hospital; retired keys stay for old sessions."""

    __tablename__ = "site_keys"
    id: Mapped[str] = mapped_column(String(50), primary_key=True)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"), index=True)
    public_key_pem: Mapped[str] = mapped_column(Text)
    #: SHA-256 of the DER public key (hex), shown in the dashboard to compare with the connector.
    fingerprint: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(10), default="active")  # active | retired
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    retired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RecordingPlan(Base):
    """What a patient records at home, set by their doctor (M13). No free text."""

    __tablename__ = "recording_plans"
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), primary_key=True)
    tests: Mapped[list] = mapped_column(Json)
    every_days: Mapped[int] = mapped_column(Integer)
    med_state: Mapped[str] = mapped_column(String(3))  # OFF | ON | ANY
    updated_by: Mapped[str] = mapped_column(String(32))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class DeletionRequest(Base):
    """A patient withdrew consent and asked for their recordings to be deleted (M13). The hospital
    deletes them in its storage; the platform deletes its records of them."""

    __tablename__ = "deletion_requests"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"), index=True)
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"))
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    status: Mapped[str] = mapped_column(String(10), default="pending")  # pending | done
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    done_by: Mapped[str | None] = mapped_column(String(32))


class UsedNonce(Base):
    """Signed-request nonces seen within the window (replay protection shared by all API replicas)."""

    __tablename__ = "used_nonces"
    nonce: Mapped[str] = mapped_column(String(64), primary_key=True)
    signer: Mapped[str] = mapped_column(String(64))
    seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)


class StaffUser(Base):
    """Web dashboard accounts (M10): platform admins (no site), hospital admins and doctors."""

    __tablename__ = "staff_users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    site_id: Mapped[str | None] = mapped_column(ForeignKey("sites.id"))
    role: Mapped[str] = mapped_column(String(20))  # platform_admin | hospital_admin | doctor
    email: Mapped[str] = mapped_column(String(254), unique=True)
    display_name: Mapped[str | None] = mapped_column(String(120))
    password_hash: Mapped[str | None] = mapped_column(String(200))
    totp_secret: Mapped[str | None] = mapped_column(String(64))
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    #: Wrong passwords or codes in a row; at staff.maxFailedLogins the account is locked until an
    #: admin unlocks it.
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    invite_token_hash: Mapped[str | None] = mapped_column(String(64), unique=True)
    invite_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class StaffRefreshToken(Base):
    __tablename__ = "staff_refresh_tokens"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("staff_users.id"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)


class DeviceEnrollment(Base):
    """One-time phone registration code made in the hospital dashboard (QR or typed), 24 h."""

    __tablename__ = "device_enrollments"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"))
    code_hash: Mapped[str] = mapped_column(String(64), unique=True)
    label: Mapped[str | None] = mapped_column(String(60))
    created_by: Mapped[str] = mapped_column(String(32))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    device_id: Mapped[str | None] = mapped_column(String(32))


class PatientAccount(Base):
    """A patient's app account (M10): by NCID only. Invited by the hospital; then a PIN."""

    __tablename__ = "patient_accounts"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"))
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), unique=True)
    status: Mapped[str] = mapped_column(String(10), default="invited")  # invited | active | locked | closed
    invite_token_hash: Mapped[str | None] = mapped_column(String(64), unique=True)
    invite_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    invite_channel: Mapped[str | None] = mapped_column(String(10))  # email | sms | print
    pin_hash: Mapped[str | None] = mapped_column(String(200))
    failed_pins: Mapped[int] = mapped_column(Integer, default=0)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id"))
    consent_version: Mapped[str | None] = mapped_column(String(50))
    consent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class PatientRefreshToken(Base):
    __tablename__ = "patient_refresh_tokens"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(ForeignKey("patient_accounts.id"))
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    #: Hospital the event belongs to (null = platform-level event).
    site_id: Mapped[str | None] = mapped_column(String(32), index=True)
    actor_id: Mapped[str | None] = mapped_column(String(32))
    actor_type: Mapped[str] = mapped_column(String(20))  # operator | device | system
    action: Mapped[str] = mapped_column(String(50))
    target_type: Mapped[str | None] = mapped_column(String(20))
    target_id: Mapped[str | None] = mapped_column(String(32))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    details: Mapped[dict | None] = mapped_column(Json)
