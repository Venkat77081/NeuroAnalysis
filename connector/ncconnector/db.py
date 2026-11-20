"""The connector's own database (in the hospital). The only place a NCID meets an MRN."""

from datetime import UTC, datetime
from functools import lru_cache
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Integer,
    String,
    Text,
    TypeDecorator,
    UniqueConstraint,
    create_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
from sqlalchemy.pool import StaticPool

from ncconnector.config import get_settings


def now() -> datetime:
    return datetime.now(UTC)


class UTCDateTime(TypeDecorator):
    """Stored in UTC, always read back with its time zone (SQLite drops it; same as the platform)."""

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


class Base(DeclarativeBase):
    pass


class NcidMap(Base):
    __tablename__ = "nc_ncid_map"
    ncid: Mapped[str] = mapped_column(String(40), primary_key=True)
    mrn: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)
    #: Platform user ID of the staff member (no names).
    created_by: Mapped[str | None] = mapped_column(String(32))


class ActivityLog(Base):
    """Clinical activity (who viewed, invited, reviewed). Hospital-owned."""

    __tablename__ = "nc_activity_log"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid4().hex)
    at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)
    actor_type: Mapped[str] = mapped_column(String(20))
    actor_id: Mapped[str | None] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(50))
    ncid: Mapped[str | None] = mapped_column(String(40))
    details: Mapped[dict | None] = mapped_column(JSON)


class UsedNonce(Base):
    """Nonces of signed platform requests within the window (replay protection across restarts)."""

    __tablename__ = "nc_used_nonces"
    nonce: Mapped[str] = mapped_column(String(64), primary_key=True)
    seen_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now, index=True)


class Review(Base):
    """A doctor's review of a recording (M14): usable or not, with a note. Hospital-owned; the
    platform never receives the note."""

    __tablename__ = "nc_reviews"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid4().hex)
    take_id: Mapped[str] = mapped_column(String(32), index=True)
    ncid: Mapped[str] = mapped_column(String(40), index=True)
    usable: Mapped[bool] = mapped_column(Boolean)
    note: Mapped[str | None] = mapped_column(String(2000))
    reviewer_id: Mapped[str] = mapped_column(String(64))
    #: Decision 061: who reviewed, as shown to other doctors (their display name at the time).
    reviewer_name: Mapped[str | None] = mapped_column(String(120))
    at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)


class BiomarkerRun(Base):
    """M15 (decision 059): the biomarkers of one take, computed at the hospital. The result (values)
    and the report (HTML with the working) are hospital-owned; the platform never receives them."""

    __tablename__ = "nc_biomarker_runs"
    take_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    ncid: Mapped[str] = mapped_column(String(40), index=True)
    test_code: Mapped[str] = mapped_column(String(8))
    status: Mapped[str] = mapped_column(String(16))  # running | done | failed
    reason: Mapped[str | None] = mapped_column(String(200))
    result: Mapped[dict | None] = mapped_column(JSON)
    report: Mapped[str | None] = mapped_column(Text)
    requested_by: Mapped[str] = mapped_column(String(64))
    requested_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class BiomarkerFiles(Base):
    """Decision 060: where a take's biomarker result and report are, in the hospital's own storage
    (encrypted with a data key wrapped by the hospital's take key)."""

    __tablename__ = "nc_biomarker_files"
    take_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    key_id: Mapped[str] = mapped_column(String(50))
    wrapped_key: Mapped[str] = mapped_column(String(1024))
    locations: Mapped[dict] = mapped_column(JSON)
    stored_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)


class KeyValue(Base):
    """Small connector state (decision 060: where the automatic analysis has looked up to)."""

    __tablename__ = "nc_state"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(String(200))


class VisitRemark(Base):
    """Decision 040: one free-text note per appointment, by that appointment's doctor ("visit
    remarks"). Hospital-owned, like reviews; the platform never receives the text."""

    __tablename__ = "nc_visit_remarks"
    appointment_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    ncid: Mapped[str] = mapped_column(String(40), index=True)
    text: Mapped[str] = mapped_column(String(4000))
    author_id: Mapped[str] = mapped_column(String(64))
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)


class Remark(Base):
    """Decision 061: visit remarks, one per doctor per appointment, with the author's name. After a
    move to another doctor, the new doctor adds their own remark; the earlier one stays (read only).
    Replaces `nc_visit_remarks` (copied over at start-up)."""

    __tablename__ = "nc_remarks"
    __table_args__ = (UniqueConstraint("appointment_id", "author_id"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid4().hex)
    appointment_id: Mapped[str] = mapped_column(String(32), index=True)
    ncid: Mapped[str] = mapped_column(String(40), index=True)
    author_id: Mapped[str] = mapped_column(String(64))
    author_name: Mapped[str | None] = mapped_column(String(120))
    text: Mapped[str] = mapped_column(String(4000))
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)


class MessagingSettings(Base):
    """Decision 042: e-mail and SMS settings the hospital admin enters in the dashboard. One row.
    The whole document is encrypted (AES-GCM, key derived from this connector's signing key);
    values set in the connector's environment always win."""

    __tablename__ = "nc_messaging_settings"
    id: Mapped[str] = mapped_column(String(16), primary_key=True, default="default")
    sealed: Mapped[str] = mapped_column(Text)
    #: Result of the last test per channel: {"email": "working"|"failing", "sms": ..., "*_at": iso}.
    tests: Mapped[dict | None] = mapped_column(JSON)
    updated_by: Mapped[str | None] = mapped_column(String(64))
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)


class LogSpool(Base):
    """Activity entries waiting for an unreachable log server (resilience, PLATFORM_PLAN §3)."""

    __tablename__ = "nc_log_spool"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid4().hex)
    payload: Mapped[dict] = mapped_column(JSON)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=now)


@lru_cache
def get_engine():
    url = get_settings().database_url
    if url.startswith("sqlite") and ":memory:" in url:
        return create_engine(url, connect_args={"check_same_thread": False}, poolclass=StaticPool)
    return create_engine(url, pool_pre_ping=True)


@lru_cache
def factory():
    return sessionmaker(get_engine(), expire_on_commit=False)


def init_db() -> None:
    engine = get_engine()
    Base.metadata.create_all(engine)
    _upgrade(engine)


def _upgrade(engine) -> None:
    """Small in-place upgrades (no migration tool here): add columns that newer versions need, and
    copy visit remarks into `nc_remarks` (decision 061). Safe to run at every start."""
    from sqlalchemy import inspect, text

    cols = {c["name"] for c in inspect(engine).get_columns("nc_reviews")}
    with engine.begin() as con:
        if "reviewer_name" not in cols:
            con.execute(text("ALTER TABLE nc_reviews ADD COLUMN reviewer_name VARCHAR(120)"))
    with factory()() as db:
        have = {(r.appointment_id, r.author_id) for r in db.query(Remark).all()}
        for old in db.query(VisitRemark).all():
            if (old.appointment_id, old.author_id) not in have:
                db.add(
                    Remark(
                        appointment_id=old.appointment_id,
                        ncid=old.ncid,
                        author_id=old.author_id,
                        text=old.text,
                        updated_at=old.updated_at,
                    )
                )
        db.commit()


def get_db():
    with factory()() as db:
        yield db
