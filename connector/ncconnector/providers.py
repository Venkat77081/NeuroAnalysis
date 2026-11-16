"""Invite and reminder delivery from the hospital's side (e-mail with QR code, SMS, print), through
the hospital's own mail server (SMTP) and SMS provider (ncconnector/delivery.py). "dummy" keeps
messages in memory (dev, tests). Addresses are never logged."""

import io
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path

import segno

from ncconnector.config import get_settings
from ncconnector.delivery import build_email, send_sms_via, send_smtp

log = logging.getLogger("ncconnector.providers")


@dataclass
class Message:
    channel: str
    to: str
    subject: str
    body: str
    attachments: dict[str, bytes] = field(default_factory=dict)


OUTBOX: list[Message] = []


@lru_cache
def messages(lang: str) -> dict:
    """Same text file as the platform (config/messages/<lang>.json), packaged with the image."""
    return json.loads((Path(__file__).parent / "messages" / f"{lang}.json").read_text())


def text(key: str, part: str, **values) -> str:
    return messages(get_settings().message_lang)[key][part].format(**values)


def qr_png(link: str) -> bytes:
    out = io.BytesIO()
    segno.make(link, error="m").save(out, kind="png", scale=8, border=4)
    return out.getvalue()


def delivery_settings():
    """Environment settings plus what the hospital admin saved in the dashboard (decision 042)."""
    from ncconnector.db import factory
    from ncconnector.messaging import effective

    with factory()() as db:
        return effective(db)


def _email(to: str, subject: str, body: str, attachments: dict[str, bytes] | None = None) -> None:
    s = delivery_settings()
    if s.email_provider == "dummy":
        OUTBOX.append(Message("email", to, subject, body, attachments or {}))
        log.info("e-mail queued (dummy provider)")
        return
    send_smtp(s, build_email(s, to, subject, body, attachments))
    log.info("e-mail sent")


def _sms(to: str, body: str, template: str) -> None:
    s = delivery_settings()
    if s.sms_provider == "dummy":
        OUTBOX.append(Message("sms", to, "", body))
        log.info("SMS queued (dummy provider)")
        return
    send_sms_via(s, to, body, template)
    log.info("SMS sent")


def send_test(channel: str, to: str) -> None:
    """The dashboard's "Send a test" (decision 042). Raises DeliveryError on failure."""
    hospital = get_settings().hospital_name
    if channel == "email":
        _email(
            to, text("testEmail", "subject", hospital=hospital), text("testEmail", "body", hospital=hospital)
        )
    else:
        # India: only DLT-registered texts are delivered, so the test uses the reminder template.
        due = datetime.now(UTC).strftime("%d %b")
        _sms(to, text("reminderSms", "body", hospital=hospital, due=due, appointment=""), "reminderSms")


def send_invite(channel: str, to: str, link: str, days: int) -> None:
    """Raises DeliveryError when the mail server or SMS provider refuses."""
    hospital = get_settings().hospital_name
    if channel == "email":
        _email(
            to,
            text("patientInviteEmail", "subject", hospital=hospital),
            text("patientInviteEmail", "body", hospital=hospital, link=link, days=days),
            {"invite-qr.png": qr_png(link)},
        )
    elif channel == "sms":
        _sms(
            to, text("patientInviteSms", "body", hospital=hospital, link=link, days=days), "patientInviteSms"
        )


def send_reminder(channel: str, to: str, due: str, appointment: str | None) -> None:
    """v3: "please record by …" for an open recording request. Raises DeliveryError."""
    hospital = get_settings().hospital_name
    appt = text("reminderAppointment", "suffix", appointment=appointment) if appointment else ""
    if channel == "email":
        _email(
            to,
            text("reminderEmail", "subject", hospital=hospital, due=due),
            text("reminderEmail", "body", hospital=hospital, due=due, appointment=appt),
        )
    else:
        _sms(to, text("reminderSms", "body", hospital=hospital, due=due, appointment=appt), "reminderSms")
