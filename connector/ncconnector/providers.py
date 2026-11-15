"""Invite delivery from the hospital's side (e-mail with QR code, SMS, print). Only dummy
providers exist until the hospital's mail and SMS accounts are configured (decision 024): messages
are kept in memory. Addresses are never logged."""

import io
import json
import logging
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import segno

from ncconnector.config import get_settings

log = logging.getLogger("ncconnector.providers")


@dataclass
class Message:
    channel: str
    to: str
    subject: str
    body: str
    attachments: dict[str, bytes] = field(default_factory=dict)


OUTBOX: list[Message] = []


class ProviderNotConfiguredError(RuntimeError):
    pass


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


def send_invite(channel: str, to: str, link: str, days: int) -> None:
    s = get_settings()
    hospital = s.hospital_name
    if channel == "email":
        if s.email_provider != "dummy":
            raise ProviderNotConfiguredError(f"e-mail provider {s.email_provider!r} is not available yet")
        OUTBOX.append(
            Message(
                "email",
                to,
                text("patientInviteEmail", "subject", hospital=hospital),
                text("patientInviteEmail", "body", hospital=hospital, link=link, days=days),
                {"invite-qr.png": qr_png(link)},
            )
        )
        log.info("invite e-mail queued (dummy provider)")
    elif channel == "sms":
        if s.sms_provider != "dummy":
            raise ProviderNotConfiguredError(f"SMS provider {s.sms_provider!r} is not available yet")
        OUTBOX.append(
            Message("sms", to, "", text("patientInviteSms", "body", hospital=hospital, link=link, days=days))
        )
        log.info("invite SMS queued (dummy provider)")


def send_reminder(channel: str, to: str, due: str, appointment: str | None) -> None:
    """v3: "please record by …" for an open recording request."""
    s = get_settings()
    hospital = s.hospital_name
    appt = text("reminderAppointment", "suffix", appointment=appointment) if appointment else ""
    if channel == "email":
        if s.email_provider != "dummy":
            raise ProviderNotConfiguredError(f"e-mail provider {s.email_provider!r} is not available yet")
        OUTBOX.append(
            Message(
                "email",
                to,
                text("reminderEmail", "subject", hospital=hospital, due=due),
                text("reminderEmail", "body", hospital=hospital, due=due, appointment=appt),
            )
        )
    else:
        if s.sms_provider != "dummy":
            raise ProviderNotConfiguredError(f"SMS provider {s.sms_provider!r} is not available yet")
        OUTBOX.append(
            Message("sms", to, "", text("reminderSms", "body", hospital=hospital, due=due, appointment=appt))
        )
    log.info("reminder queued (dummy provider)")
