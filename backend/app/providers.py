"""E-mail and SMS delivery (M10). Only the dummy providers exist for now: messages are kept in
memory (dev, tests) and nothing is sent. Real providers plug in behind the same functions
(settings NC_EMAIL_PROVIDER / NC_SMS_PROVIDER) once configured. Addresses are never logged.
"""

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime

from app.config import get_settings
from app.policy import message

log = logging.getLogger("neurocapture.providers")


@dataclass
class Message:
    channel: str  # email | sms
    to: str
    subject: str
    body: str
    at: datetime = field(default_factory=lambda: datetime.now(UTC))


#: Dummy outbox (process memory). Tests read it; production providers never write here.
OUTBOX: list[Message] = []


class ProviderNotConfiguredError(RuntimeError):
    pass


def send_email(to: str, subject: str, body: str) -> None:
    provider = get_settings().email_provider
    if provider != "dummy":
        raise ProviderNotConfiguredError(f"e-mail provider {provider!r} is not available yet")
    OUTBOX.append(Message("email", to, subject, body))
    log.info("e-mail queued (dummy provider): %s", subject)


def send_sms(to: str, body: str) -> None:
    provider = get_settings().sms_provider
    if provider != "dummy":
        raise ProviderNotConfiguredError(f"SMS provider {provider!r} is not available yet")
    OUTBOX.append(Message("sms", to, "", body))
    log.info("SMS queued (dummy provider)")


def staff_invite(to: str, hospital: str, role: str, link: str, days: int) -> None:
    role_text = message("roles", role)
    send_email(
        to,
        message("staffInvite", "subject", hospital=hospital),
        message("staffInvite", "body", hospital=hospital, role=role_text, link=link, days=days),
    )


def patient_invite(channel: str, to: str, hospital: str, link: str, days: int) -> None:
    if channel == "email":
        send_email(
            to,
            message("patientInviteEmail", "subject", hospital=hospital),
            message("patientInviteEmail", "body", hospital=hospital, link=link, days=days),
        )
    elif channel == "sms":
        send_sms(to, message("patientInviteSms", "body", hospital=hospital, link=link, days=days))
