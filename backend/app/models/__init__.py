"""Database models (DEV_PLAN §13.1, PLATFORM_PLAN M10).

Patients are known only by a random NCID (decision 023): no table holds a patient's name, MRN,
e-mail address or phone number. Staff e-mail addresses (hospital admins, doctors) are stored:
they are accounts, not patient data.
"""

from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    TypeDecorator,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

Json = JSON().with_variant(JSONB(), "postgresql")


class UTCDateTime(TypeDecorator):
    """A point in time, stored in UTC and always read back with its time zone. PostgreSQL keeps the
    zone itself; SQLite (tests, the local test stack) drops it, which made the API send times without
    a zone and browsers show them as local time."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None and value.tzinfo is not None:
            return value.astimezone(UTC)
        return value

    def process_result_value(self, value, dialect):
        if value is not None and value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value


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
    #: Always byo (decision 031): the hospital runs its own connector and holds its own take key.
    data_mode: Mapped[str] = mapped_column(String(10), default="byo")
    status: Mapped[str] = mapped_column(String(12), default="active")  # invited | active | suspended
    modules: Mapped[dict] = mapped_column(Json, default=dict)  # {"clinic": true, "home": true, ...}
    city: Mapped[str | None] = mapped_column(String(100))
    connector_url: Mapped[str | None] = mapped_column(String(300))
    #: M11: the connector's Ed25519 public key (PEM). Public, not a secret.
    connector_public_key: Mapped[str | None] = mapped_column(Text)
    #: Last health check: {"records": "pass", ...} — pass/fail only, never data.
    connector_check: Mapped[dict | None] = mapped_column(Json)
    connector_checked_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    # Where this hospital's recordings are stored (decision 044: always the hospital's own).
    # none = not connected yet (no recording) | s3 | azure | dev (development storage, tests only).
    storage_kind: Mapped[str] = mapped_column(String(10), default="none")
    #: s3: {bucket, region, endpoint?, prefix, role_arn, kms_key_id?}. References only, no secrets.
    storage_config: Mapped[dict | None] = mapped_column(Json)
    #: ExternalId the hospital puts in its role's trust policy (generated here, not a secret).
    storage_external_id: Mapped[str | None] = mapped_column(String(64))
    storage_check: Mapped[dict | None] = mapped_column(Json)
    storage_checked_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    #: Decision 033: {permission: [roles]} where this hospital differs from config/platform.json.
    permissions: Mapped[dict | None] = mapped_column(Json)
    sms_enabled: Mapped[bool] = mapped_column(Boolean, default=False)  # hospital pays for SMS
    #: v10 (decision 042): what the connector reports about its e-mail and SMS, never the settings:
    #: {"email": "working"|"failing"|"off", "sms": ..., "at": iso}.
    messaging_status: Mapped[dict | None] = mapped_column(Json)
    onboarded_by: Mapped[str | None] = mapped_column(String(32))
    onboarded_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    #: v13: hospital settings a hospital admin changes in the dashboard, where they differ from
    #: config/platform.json: {"device_min_fps", "change_cutoff_hours", "patient_changes", "time_zone"}.
    settings: Mapped[dict | None] = mapped_column(Json)


class Operator(Base):
    __tablename__ = "operators"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"))
    #: Operator code typed at login (e.g. OP-07); not a name.
    code: Mapped[str] = mapped_column(String(20))
    #: The operator's name, shown in activity logs (staff are NeuroCapture accounts, not patients).
    name: Mapped[str | None] = mapped_column(String(120))
    display_name_hash: Mapped[str | None] = mapped_column(String(64))
    #: Password hash (M10: operator ID + password; earlier operators used a PIN, same hash format).
    pin_hash: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(20), default="operator")  # operator | reviewer | admin
    #: Set by a hospital admin's reset: the operator must choose a new password at next sign-in.
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    #: Wrong passwords in a row (M13); at operators.maxFailedLogins the account locks until a
    #: hospital admin resets or re-enables it. Phones unlock by signing in again, so this counts.
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
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
    #: Camera check before the phone was added (user, 16 Nov 2026): measured frames per second.
    check_fps: Mapped[float | None] = mapped_column(Float)
    checked_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    #: Decision 062: brand, video size, memory and storage from the phone check and before each
    #: visit (app/phones.py). Device data only, never anything about the patient.
    device_report: Mapped[dict | None] = mapped_column(Json)
    device_report_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    registered_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    operator_id: Mapped[str] = mapped_column(ForeignKey("operators.id"))
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
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
    started_at: Mapped[datetime] = mapped_column(UTCDateTime())
    ended_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    aborted: Mapped[dict | None] = mapped_column(Json)
    med_state: Mapped[str] = mapped_column(String(3))
    app_version: Mapped[str] = mapped_column(String(20))
    config_versions: Mapped[dict] = mapped_column(Json)
    consent_version: Mapped[str] = mapped_column(String(50))
    consent_at: Mapped[datetime] = mapped_column(UTCDateTime())
    #: M12: the hospital key the phone must wrap this session's take keys with (null = pre-M12).
    key_id: Mapped[str | None] = mapped_column(String(50))
    #: v3: the recording request this session answers (home recording before an appointment).
    request_id: Mapped[str | None] = mapped_column(String(32), index=True)
    #: v16 (decision 047): where consent for a clinic recording came from: patient_app (the
    #: patient's QR, scanned) | clinic_phone (with a reason). Null: as before (home, or older apps).
    consent_source: Mapped[str | None] = mapped_column(String(12))
    consent_reason: Mapped[str | None] = mapped_column(String(24))
    consent_id: Mapped[str | None] = mapped_column(String(32))
    #: Measured fps of every take recorded in the session, retakes included (decision 035).
    attempt_fps: Mapped[list | None] = mapped_column(Json)
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
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)
    uploaded_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
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
    uploaded_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
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
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)


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
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)
    retired_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class RecordingPlan(Base):
    """What a patient records at home, set by their doctor (M13). No free text."""

    __tablename__ = "recording_plans"
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), primary_key=True)
    tests: Mapped[list] = mapped_column(Json)
    every_days: Mapped[int] = mapped_column(Integer)
    med_state: Mapped[str] = mapped_column(String(3))  # OFF | ON | ANY
    updated_by: Mapped[str] = mapped_column(String(32))
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)
    #: v3: the doctor asked for recording every `every_days` days (otherwise appointments only).
    periodic: Mapped[bool] = mapped_column(Boolean, default=False)
    #: v3: when the doctor turned periodic recording on. It ends at the patient's first booked
    #: appointment after this time ("until the next appointment").
    periodic_since: Mapped[datetime | None] = mapped_column(UTCDateTime())
    #: M14: the doctor asked for a new recording (due at once until the patient records again).
    rerecord_requested_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    rerecord_tests: Mapped[list | None] = mapped_column(Json)


class DeletionRequest(Base):
    """A patient withdrew consent and asked for their recordings to be deleted (M13). The hospital
    deletes them in its storage; the platform deletes its records of them."""

    __tablename__ = "deletion_requests"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"), index=True)
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"))
    requested_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)
    status: Mapped[str] = mapped_column(String(10), default="pending")  # pending | done
    done_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    done_by: Mapped[str | None] = mapped_column(String(32))


class PatientAssignment(Base):
    """Which doctor a patient is assigned to (M14, set by a receptionist or hospital admin). A doctor
    sees only their assigned patients, on the platform and on the hospital connector."""

    __tablename__ = "patient_assignments"
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), primary_key=True)
    doctor_id: Mapped[str] = mapped_column(ForeignKey("staff_users.id"), index=True)
    assigned_by: Mapped[str] = mapped_column(String(32))
    assigned_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)


class UsedNonce(Base):
    """Signed-request nonces seen within the window (replay protection shared by all API replicas)."""

    __tablename__ = "used_nonces"
    nonce: Mapped[str] = mapped_column(String(64), primary_key=True)
    signer: Mapped[str] = mapped_column(String(64))
    seen_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now, index=True)


class StaffUser(Base):
    """Web dashboard accounts (M10): platform admins (no site), hospital admins and doctors."""

    __tablename__ = "staff_users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    site_id: Mapped[str | None] = mapped_column(ForeignKey("sites.id"))
    #: platform_admin | hospital_admin | doctor | receptionist
    role: Mapped[str] = mapped_column(String(20))
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
    invite_expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created_by: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)
    last_login_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class StaffRefreshToken(Base):
    __tablename__ = "staff_refresh_tokens"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("staff_users.id"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)


class DeviceEnrollment(Base):
    """One-time phone registration code made in the hospital dashboard (QR or typed), 24 h."""

    __tablename__ = "device_enrollments"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"))
    code_hash: Mapped[str] = mapped_column(String(64), unique=True)
    label: Mapped[str | None] = mapped_column(String(60))
    created_by: Mapped[str] = mapped_column(String(32))
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
    used_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    device_id: Mapped[str | None] = mapped_column(String(32))


class PatientAccount(Base):
    """A patient's app account (M10): by NCID only. Invited by the hospital; then a PIN."""

    __tablename__ = "patient_accounts"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"))
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), unique=True)
    status: Mapped[str] = mapped_column(String(10), default="invited")  # invited | active | locked | closed
    invite_token_hash: Mapped[str | None] = mapped_column(String(64), unique=True)
    invite_expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    invite_channel: Mapped[str | None] = mapped_column(String(10))  # email | sms | print
    pin_hash: Mapped[str | None] = mapped_column(String(200))
    failed_pins: Mapped[int] = mapped_column(Integer, default=0)
    device_id: Mapped[str | None] = mapped_column(ForeignKey("devices.id"))
    consent_version: Mapped[str | None] = mapped_column(String(50))
    consent_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created_by: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)
    #: v3: when the patient withdrew from this hospital (status closed). Cleared on re-joining.
    withdrawn_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    #: The patient's phone failed the camera check and they told the hospital (record in clinic).
    camera_failed_fps: Mapped[float | None] = mapped_column(Float)
    camera_failed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class Appointment(Base):
    """v3: an appointment the hospital booked (read from its FHIR system, or entered by reception).
    Only the time, doctor and source are kept here; the details stay in the hospital's system."""

    __tablename__ = "appointments"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"), index=True)
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), index=True)
    at: Mapped[datetime] = mapped_column(UTCDateTime())
    doctor_id: Mapped[str | None] = mapped_column(ForeignKey("staff_users.id"))
    source: Mapped[str] = mapped_column(String(6))  # fhir | manual
    #: SHA-256 of the hospital's appointment ID (FHIR), to avoid duplicates.
    external_ref_hash: Mapped[str | None] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(10), default="booked")  # booked | cancelled
    created_by: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)
    #: v13: the time the hospital system last gave (FHIR). A desk change is kept until this changes.
    external_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    #: v13: the last move: when it was, from when, from which doctor, and why.
    moved_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    moved_from: Mapped[datetime | None] = mapped_column(UTCDateTime())
    moved_from_doctor_id: Mapped[str | None] = mapped_column(String(32))
    moved_reason: Mapped[str | None] = mapped_column(String(24))
    #: v14: who cancelled (staff | patient), why (a code from config), when; the desk's "seen".
    cancelled_by: Mapped[str | None] = mapped_column(String(10))
    cancel_reason: Mapped[str | None] = mapped_column(String(24))
    cancelled_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    cancel_seen_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    #: v14: the doctor changed before the patient recorded: the earlier choice, for the new doctor
    #: to confirm ({"tests", "med_state", "places", "from_doctor"}). Cleared when they send tests.
    suggested_tests: Mapped[dict | None] = mapped_column(Json)
    __table_args__ = (UniqueConstraint("site_id", "external_ref_hash"),)


class AppointmentChangeRequest(Base):
    """A patient's request (no free text reaches the platform).

    - kind "change" (v13/v14): another time for one appointment.
    - kind "booking" (v14): a new appointment, with a preferred doctor (or any).
    v14: `choices` = exact free times [{"at", "rank": preferred | alternative}]; v13 rows kept
    `days` + `part_of_day` instead."""

    __tablename__ = "appointment_change_requests"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"), index=True)
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), index=True)
    #: Booking: set once the desk (or the patient's choice of an offer) books it.
    appointment_id: Mapped[str | None] = mapped_column(ForeignKey("appointments.id"), index=True)
    kind: Mapped[str] = mapped_column(String(8), default="change")  # change | booking
    #: Booking: the preferred doctor (null = any). Change: null = the appointment's doctor only.
    doctor_id: Mapped[str | None] = mapped_column(String(32))
    any_doctor: Mapped[bool] = mapped_column(Boolean, default=False)
    choices: Mapped[list | None] = mapped_column(Json)
    purpose: Mapped[str | None] = mapped_column(String(20))  # booking: follow_up | ...
    days: Mapped[list | None] = mapped_column(Json)  # v13 only
    part_of_day: Mapped[str | None] = mapped_column(String(10))  # v13 only
    reason: Mapped[str | None] = mapped_column(String(20))
    #: open → accepted (moved / booked) | offered (the desk sent other times) | declined |
    #: withdrawn (by the patient) | closed (moved or cancelled otherwise).
    status: Mapped[str] = mapped_column(String(10), default="open")
    answer: Mapped[str | None] = mapped_column(String(20))  # declined: a code from config
    answered_by: Mapped[str | None] = mapped_column(String(32))
    answered_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)


class AppointmentOffer(Base):
    """v14: the desk offers the patient up to `offer_max` times (date, time, doctor) to move an
    appointment, or to book one they asked for. The times are held until `reply_by`. The patient
    chooses one, keeps the current date (when still possible), asks to be called, or cancels."""

    __tablename__ = "appointment_offers"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"), index=True)
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), index=True)
    appointment_id: Mapped[str | None] = mapped_column(ForeignKey("appointments.id"), index=True)
    request_id: Mapped[str | None] = mapped_column(String(32))
    options: Mapped[list] = mapped_column(Json)  # [{"at": iso, "doctor_id": id}]
    #: The current date may still be kept (else the patient must choose or cancel).
    current_possible: Mapped[bool] = mapped_column(Boolean, default=False)
    reason: Mapped[str] = mapped_column(String(24))
    reply_by: Mapped[datetime] = mapped_column(UTCDateTime())
    #: open | chosen | kept | call_requested | declined (patient cancelled) | withdrawn (desk) | closed
    status: Mapped[str] = mapped_column(String(16), default="open")
    chosen: Mapped[int | None] = mapped_column(Integer)
    answered_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created_by: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)


class AppointmentNotice(Base):
    """v13: tell the patient by SMS or e-mail that an appointment moved (or could not be). The
    platform has no contact details: the hospital connector collects these and sends them."""

    __tablename__ = "appointment_notices"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"), index=True)
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"))
    appointment_id: Mapped[str | None] = mapped_column(ForeignKey("appointments.id"))
    offer_id: Mapped[str | None] = mapped_column(String(32))
    #: moved | not_changed | offer | cancelled | booked | not_booked
    kind: Mapped[str] = mapped_column(String(12))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)
    sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class DoctorHours(Base):
    """v13: a doctor's weekly clinic hours and leave, used only to suggest free times when moving
    an appointment. week: {"mon": [["09:00", "13:00"], ...], ...} in the hospital's time zone;
    leave: [{"from": "2026-11-24", "to": "2026-11-28"}]."""

    __tablename__ = "doctor_hours"
    doctor_id: Mapped[str] = mapped_column(ForeignKey("staff_users.id"), primary_key=True)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"), index=True)
    department: Mapped[str | None] = mapped_column(String(80))
    week: Mapped[dict] = mapped_column(Json, default=dict)
    slot_minutes: Mapped[int] = mapped_column(Integer, default=15)
    #: v14: offered to patients booking in the app.
    bookable: Mapped[bool] = mapped_column(Boolean, default=True)
    leave: Mapped[list] = mapped_column(Json, default=list)
    updated_by: Mapped[str | None] = mapped_column(String(32))
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)


class RecordingRequest(Base):
    """v3: "please record these tests by this date", sent to a patient's app (usually for an
    appointment, or a doctor's re-record request)."""

    __tablename__ = "recording_requests"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"), index=True)
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"), index=True)
    appointment_id: Mapped[str | None] = mapped_column(ForeignKey("appointments.id"))
    kind: Mapped[str] = mapped_column(String(10), default="appointment")  # appointment | rerecord
    tests: Mapped[list] = mapped_column(Json)
    #: v31 (decision 054): {test code: seconds} the phone records each take for; null on older
    #: requests (the config's lengths).
    durations: Mapped[dict | None] = mapped_column(Json, nullable=True)
    med_state: Mapped[str] = mapped_column(String(3))  # OFF | ON | ANY
    due_at: Mapped[datetime] = mapped_column(UTCDateTime())
    remind: Mapped[bool] = mapped_column(Boolean, default=True)
    reminder_sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    status: Mapped[str] = mapped_column(String(10), default="open")  # open | cancelled | not_done
    #: home = record link in the patient's app; clinic = the clinic phones' queue (user, 16 Nov 2026).
    place: Mapped[str] = mapped_column(String(6), default="home")
    #: Clinic requests the operator could not record: reason code and operator.
    not_done_reason: Mapped[str | None] = mapped_column(String(30))
    not_done_by: Mapped[str | None] = mapped_column(String(32))
    created_by: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)


class PatientRefreshToken(Base):
    __tablename__ = "patient_refresh_tokens"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(ForeignKey("patient_accounts.id"))
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
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
    at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)
    details: Mapped[dict | None] = mapped_column(Json)


class AppAccount(Base):
    """v11 (decision 043): the patient's app account, one per person, for every hospital on their
    phone. Holds no address and no hospital: the e-mail only as a keyed fingerprint, the PIN as a
    slow hash, and an encrypted backup of the phone's hospital list that only the phone can open
    (with the PIN plus a server secret, or with the recovery code the patient saved)."""

    __tablename__ = "app_accounts"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    #: HMAC-SHA256(account pepper, normalised e-mail). The address itself is never stored.
    email_fp: Mapped[str] = mapped_column(String(64), unique=True)
    pin_hash: Mapped[str] = mapped_column(String(200))
    failed_pins: Mapped[int] = mapped_column(Integer, default=0)
    paused_until: Mapped[datetime | None] = mapped_column(UTCDateTime())
    #: Salt for the phone's PIN key derivation (not secret).
    kdf_salt: Mapped[str] = mapped_column(String(64))
    #: SHA-256 of the recovery-code check value (the phone derives it; the code never reaches us).
    recovery_check_hash: Mapped[str | None] = mapped_column(String(64))
    #: The phone's sealed hospital list and the two locked copies of its key (all base64, opaque).
    backup: Mapped[str | None] = mapped_column(Text)
    wrap_pin: Mapped[str | None] = mapped_column(Text)
    wrap_recovery: Mapped[str | None] = mapped_column(Text)
    backup_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)


class AppAccountCode(Base):
    """One-time e-mail code (sign-up, sign-in, forgot PIN). Stored as a hash, by e-mail fingerprint."""

    __tablename__ = "app_account_codes"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    email_fp: Mapped[str] = mapped_column(String(64), index=True)
    code_hash: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    used: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)


class AppAccountToken(Base):
    """A phone signed in to the app account. One active phone per account; moving revokes the rest."""

    __tablename__ = "app_account_tokens"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(ForeignKey("app_accounts.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    #: Random ID the app keeps for its install; the same install refreshing is not "another phone".
    install_id: Mapped[str] = mapped_column(String(64))
    device_label: Mapped[str] = mapped_column(String(120))
    last_used_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    #: Why it stopped: moved (another phone took over) | signed_out | pin_reset.
    revoked_reason: Mapped[str | None] = mapped_column(String(20))


class ClinicConsent(Base):
    """v16 (decision 047): consent for one clinic recording request. Given in the patient's app
    (a one-time code shown as a QR, valid until the end of the visit day) or on the clinic phone
    (with a reason). The code is stored as a hash; it holds no identity."""

    __tablename__ = "clinic_consents"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"), index=True)
    patient_id: Mapped[str] = mapped_column(ForeignKey("patients.id"))
    request_id: Mapped[str] = mapped_column(String(32), index=True)
    #: patient_app | clinic_phone
    source: Mapped[str] = mapped_column(String(12))
    code_hash: Mapped[str | None] = mapped_column(String(64), unique=True)
    reason: Mapped[str | None] = mapped_column(String(24))
    consent_version: Mapped[str] = mapped_column(String(50))
    agreed_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)
    valid_until: Mapped[datetime] = mapped_column(UTCDateTime())
    #: active (shown, not scanned) | used (confirmed on a clinic phone) | withdrawn
    status: Mapped[str] = mapped_column(String(10), default="active")
    used_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    used_by: Mapped[str | None] = mapped_column(String(32))
    session_id: Mapped[str | None] = mapped_column(String(32))


class ConnectorPing(Base):
    """v29 (decision 052): the hospital's connector checked in with the platform during this hour
    (UTC). Counts only, kept for config connectorHealth.keepDays; nothing about patients."""

    __tablename__ = "connector_pings"
    __table_args__ = (UniqueConstraint("site_id", "hour"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    site_id: Mapped[str] = mapped_column(ForeignKey("sites.id"), index=True)
    hour: Mapped[datetime] = mapped_column(UTCDateTime())
    count: Mapped[int] = mapped_column(Integer, default=0)
    last_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)
