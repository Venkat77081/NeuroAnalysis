"""v3: reminders for open recording requests. The platform says which are due (it has no contact
details); this connector reads the patient's e-mail or mobile from the hospital's records and sends
them through the hospital's provider. Runs every NCC_REMINDER_INTERVAL_S seconds, or:

    python -m ncconnector send-reminders
"""

import logging
from datetime import datetime

from sqlalchemy.orm import Session as DbSession

from ncconnector import activity, platform
from ncconnector.db import NcidMap
from ncconnector.providers import send_reminder
from ncconnector.records import RecordsUnavailableError, records

log = logging.getLogger("ncconnector.reminders")


def _day(iso: str | None) -> str | None:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).strftime("%d %b") if iso else None


def send_due(db: DbSession) -> int:
    """Returns how many reminders were sent."""
    sent = 0
    for r in platform.call("GET", "/connector/v1/reminders/due") or []:
        m = db.get(NcidMap, r["ncid"])
        if m is None:
            continue
        try:
            rec = records().get(m.mrn)
        except RecordsUnavailableError:
            log.warning("records unreachable; reminders retried later")
            return sent
        if rec is None or not (rec.email or rec.phone):
            continue
        channel, to = ("email", rec.email) if rec.email else ("sms", rec.phone)
        send_reminder(channel, to, _day(r["due_at"]) or "", _day(r.get("appointment_at")))
        platform.call("POST", f"/connector/v1/reminders/{r['request_id']}/sent", {})
        activity.write(db, "system", None, "reminder_sent", r["ncid"], channel=channel)
        sent += 1
    return sent
