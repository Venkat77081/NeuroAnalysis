"""v29 (decision 052): is the hospital's connector checking in? Every signed call from a
connector (and its heartbeat every connectorHealth.heartbeatSeconds) counts towards the hour it
falls in. Dashboards show one bar per hour and "offline since" (config/platform.json)."""

from datetime import UTC, datetime, timedelta

from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DbSession

from app.models import ConnectorPing, Site
from app.policy import policy


def _cfg() -> dict:
    return policy()["connectorHealth"]


def hour_of(at: datetime) -> datetime:
    return at.astimezone(UTC).replace(minute=0, second=0, microsecond=0)


def record_ping(db: DbSession, site_id: str, at: datetime | None = None) -> None:
    """Counts one check-in. Commits on its own so it never mixes with the caller's changes."""
    at = at or datetime.now(UTC)
    hour = hour_of(at)
    for _ in range(2):
        row = db.scalar(
            select(ConnectorPing).where(ConnectorPing.site_id == site_id, ConnectorPing.hour == hour)
        )
        if row:
            row.count += 1
            row.last_at = at
        else:
            db.add(ConnectorPing(site_id=site_id, hour=hour, count=1, last_at=at))
            # A new hour: drop counts older than keepDays for this hospital.
            db.execute(
                delete(ConnectorPing).where(
                    ConnectorPing.site_id == site_id,
                    ConnectorPing.hour < hour - timedelta(days=_cfg()["keepDays"]),
                )
            )
        try:
            db.commit()
            return
        except IntegrityError:  # another request added the hour first: count on that row
            db.rollback()


class HourOut(BaseModel):
    start: datetime
    pings: int


class ConnectorHistoryOut(BaseModel):
    registered: bool
    #: null: never checked in.
    last_seen_at: datetime | None
    online: bool
    #: When it stopped checking in (null while online or never seen).
    offline_since: datetime | None
    heartbeat_seconds: int
    offline_after_minutes: int
    #: Oldest first; the last one is the current hour.
    hours: list[HourOut]


def last_seen(db: DbSession, site_id: str) -> datetime | None:
    return db.scalar(
        select(ConnectorPing.last_at)
        .where(ConnectorPing.site_id == site_id)
        .order_by(ConnectorPing.hour.desc())
        .limit(1)
    )


def is_online(seen: datetime | None, at: datetime | None = None) -> bool:
    at = at or datetime.now(UTC)
    return bool(seen) and at - seen <= timedelta(minutes=_cfg()["offlineAfterMinutes"])  # type: ignore[operator]


def history(db: DbSession, site: Site, at: datetime | None = None) -> ConnectorHistoryOut:
    cfg = _cfg()
    at = at or datetime.now(UTC)
    now_hour = hour_of(at)
    first = now_hour - timedelta(hours=cfg["historyHours"] - 1)
    rows = {
        hour_of(r.hour): r.count
        for r in db.scalars(
            select(ConnectorPing).where(ConnectorPing.site_id == site.id, ConnectorPing.hour >= first)
        )
    }
    seen = last_seen(db, site.id)
    online = is_online(seen, at)
    return ConnectorHistoryOut(
        registered=bool(site.connector_public_key),
        last_seen_at=seen,
        online=online,
        offline_since=None if online or not seen else seen,
        heartbeat_seconds=cfg["heartbeatSeconds"],
        offline_after_minutes=cfg["offlineAfterMinutes"],
        hours=[
            HourOut(start=first + timedelta(hours=i), pings=rows.get(first + timedelta(hours=i), 0))
            for i in range(cfg["historyHours"])
        ],
    )
