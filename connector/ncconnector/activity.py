"""Clinical activity log (PLATFORM_PLAN §3): written to the hospital's database (this connector's
DB) or its log server. If the log server is down, entries wait in a spool and are retried."""

import logging
from datetime import UTC, datetime

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from ncconnector.config import get_settings
from ncconnector.db import ActivityLog, LogSpool

log = logging.getLogger("ncconnector.activity")

#: Tests inject a client for the http sink.
HTTP_CLIENT: httpx.Client | None = None


def _send_http(payload: dict) -> bool:
    url = get_settings().activity_http_url
    if not url:
        return False
    try:
        client = HTTP_CLIENT or httpx.Client(timeout=5)
        r = client.post(url, json=payload)
        return r.status_code < 300
    except httpx.HTTPError:
        return False


def write(
    db: DbSession, actor_type: str, actor_id: str | None, action: str, ncid: str | None = None, **details
):
    payload = {
        "at": datetime.now(UTC).isoformat(),
        "actor_type": actor_type,
        "actor_id": actor_id,
        "action": action,
        "ncid": ncid,
        "details": details or None,
    }
    if get_settings().activity_sink == "http":
        flush(db)
        if not _send_http(payload):
            db.add(LogSpool(payload=payload))
            log.warning("activity log server unreachable; entry spooled")
        db.commit()
        return
    db.add(
        ActivityLog(
            actor_type=actor_type, actor_id=actor_id, action=action, ncid=ncid, details=details or None
        )
    )
    db.commit()


def flush(db: DbSession) -> int:
    """Re-send spooled entries in order; stops at the first failure. Returns the number sent."""
    sent = 0
    for item in db.scalars(select(LogSpool).order_by(LogSpool.created_at)):
        if not _send_http(item.payload):
            item.attempts += 1
            break
        db.delete(item)
        sent += 1
    db.commit()
    return sent
