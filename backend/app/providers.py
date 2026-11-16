"""E-mail and SMS delivery (M10). "dummy" keeps messages in memory (dev, tests); "smtp" sends e-mail
through any SMTP service, and SMS goes through Twilio, Amazon SNS or an HTTP gateway
(app/delivery.py; settings NC_EMAIL_PROVIDER, NC_SMTP_*, NC_SMS_*). Addresses are never logged.
"""

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime

from app.config import get_settings
from app.delivery import build_email, send_sms_via, send_smtp
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


def send_email(to: str, subject: str, body: str) -> None:
    """Raises DeliveryError when the message could not be handed to the mail server."""
    s = get_settings()
    if s.email_provider == "dummy":
        OUTBOX.append(Message("email", to, subject, body))
        log.info("e-mail queued (dummy provider)")
        return
    send_smtp(s, build_email(s, to, subject, body))
    log.info("e-mail sent")


def send_sms(to: str, body: str, template: str) -> None:
    s = get_settings()
    if s.sms_provider == "dummy":
        OUTBOX.append(Message("sms", to, "", body))
        log.info("SMS queued (dummy provider)")
        return
    send_sms_via(s, to, body, template)
    log.info("SMS sent")


def staff_invite(to: str, hospital: str, role: str, link: str, days: int) -> None:
    role_text = message("roles", role)
    send_email(
        to,
        message("staffInvite", "subject", hospital=hospital),
        message("staffInvite", "body", hospital=hospital, role=role_text, link=link, days=days),
    )


def staff_reset(to: str, hospital: str, by: str, link: str, hours: int) -> None:
    """Decision 039: an admin reset this person's sign-in."""
    send_email(
        to,
        message("staffReset", "subject", hospital=hospital),
        message("staffReset", "body", hospital=hospital, by=by, link=link, hours=hours),
    )
