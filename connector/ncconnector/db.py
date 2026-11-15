"""The connector's own database (in the hospital). The only place a NCID meets an MRN."""

from datetime import UTC, datetime
from functools import lru_cache
from uuid import uuid4

from sqlalchemy import JSON, Boolean, DateTime, Integer, String, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker
from sqlalchemy.pool import StaticPool

from ncconnector.config import get_settings


def now() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class NcidMap(Base):
    __tablename__ = "nc_ncid_map"
    ncid: Mapped[str] = mapped_column(String(40), primary_key=True)
    mrn: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    #: Platform user ID of the staff member (no names).
    created_by: Mapped[str | None] = mapped_column(String(32))


class ActivityLog(Base):
    """Clinical activity (who viewed, invited, reviewed). Hospital-owned."""

    __tablename__ = "nc_activity_log"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid4().hex)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    actor_type: Mapped[str] = mapped_column(String(20))
    actor_id: Mapped[str | None] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(50))
    ncid: Mapped[str | None] = mapped_column(String(40))
    details: Mapped[dict | None] = mapped_column(JSON)


class UsedNonce(Base):
    """Nonces of signed platform requests within the window (replay protection across restarts)."""

    __tablename__ = "nc_used_nonces"
    nonce: Mapped[str] = mapped_column(String(64), primary_key=True)
    seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)


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
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class LogSpool(Base):
    """Activity entries waiting for an unreachable log server (resilience, PLATFORM_PLAN §3)."""

    __tablename__ = "nc_log_spool"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=lambda: uuid4().hex)
    payload: Mapped[dict] = mapped_column(JSON)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


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
    Base.metadata.create_all(get_engine())


def get_db():
    with factory()() as db:
        yield db
