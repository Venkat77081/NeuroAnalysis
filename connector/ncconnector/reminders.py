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
from ncconnector.delivery import DeliveryError
from ncconnector.providers import send_appointment_notice, send_reminder
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
        try:
            send_reminder(channel, to, _day(r["due_at"]) or "", _day(r.get("appointment_at")))
        except DeliveryError as exc:
            # Not marked as sent: the next run tries again.
            log.warning("reminder not delivered: %s", exc.code)
            continue
        platform.call("POST", f"/connector/v1/reminders/{r['request_id']}/sent", {})
        activity.write(db, "system", None, "reminder_sent", r["ncid"], channel=channel)
        sent += 1
    return sent


def _when(iso: str) -> str:
    """The hospital's local time the platform sent, e.g. "Wed 26 Nov, 9:45 am"."""
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return f"{dt.strftime('%a %d %b')}, {dt.strftime('%I:%M').lstrip('0')} {dt.strftime('%p').lower()}"


def send_notices(db: DbSession) -> int:
    """v13: tell patients that the desk moved an appointment, or could not. Returns how many were
    sent. A patient without e-mail or mobile in the records is skipped (marked sent: nothing to do)."""
    sent = 0
    for n in platform.call("GET", "/connector/v1/appointment-notices/due") or []:
        m = db.get(NcidMap, n["ncid"])
        rec = None
        if m is not None:
            try:
                rec = records().get(m.mrn)
            except RecordsUnavailableError:
                log.warning("records unreachable; notices retried later")
                return sent
        if rec is not None and (rec.email or rec.phone):
            channel, to = ("email", rec.email) if rec.email else ("sms", rec.phone)
            try:
                send_appointment_notice(channel, to, n["kind"], _when(n["at_local"]), n.get("doctor_name"))
            except DeliveryError as exc:
                log.warning("appointment notice not delivered: %s", exc.code)
                continue
            activity.write(db, "system", None, "appointment_notice_sent", n["ncid"], channel=channel)
            sent += 1
        platform.call("POST", f"/connector/v1/appointment-notices/{n['id']}/sent", {})
    return sent
