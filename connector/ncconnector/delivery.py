"""E-mail (SMTP) and SMS (Twilio, Amazon SNS or an HTTP gateway) delivery for invites and reminders.
Identical to backend/app/delivery.py after this docstring (tests/test_copies.py). Addresses, phone
numbers and message text are never logged. `cfg` is the connector's settings (NCC_*).
"""

import json
import logging
import re
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid

import httpx

log = logging.getLogger("neurocapture.delivery")

E164 = re.compile(r"^\+[1-9]\d{7,14}$")


class DeliveryError(RuntimeError):
    """The message could not be handed to the provider. `code`: email_not_sent | sms_not_sent |
    bad_phone | not_configured."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


# --- E-mail ---------------------------------------------------------------------------------


def build_email(
    cfg, to: str, subject: str, body: str, attachments: dict[str, bytes] | None = None
) -> EmailMessage:
    if not cfg.mail_from:
        raise DeliveryError("not_configured")
    msg = EmailMessage()
    msg["From"] = formataddr((cfg.mail_from_name, cfg.mail_from)) if cfg.mail_from_name else cfg.mail_from
    msg["To"] = to
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=False)
    msg["Message-ID"] = make_msgid(domain=cfg.mail_from.rsplit("@", 1)[-1])
    if cfg.mail_reply_to:
        msg["Reply-To"] = cfg.mail_reply_to
    msg.set_content(body)
    for name, data in (attachments or {}).items():
        maintype, subtype = ("image", "png") if name.endswith(".png") else ("application", "octet-stream")
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=name)
    return msg


def send_smtp(cfg, msg: EmailMessage) -> None:
    """One message over SMTP. smtp_security: starttls (port 587) | ssl (port 465) | none (a relay
    inside a trusted network, port 25)."""
    if not cfg.smtp_host:
        raise DeliveryError("not_configured")
    security = cfg.smtp_security
    context = ssl.create_default_context()
    try:
        if security == "ssl":
            server: smtplib.SMTP = smtplib.SMTP_SSL(
                cfg.smtp_host, cfg.smtp_port, timeout=cfg.smtp_timeout_s, context=context
            )
        else:
            server = smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=cfg.smtp_timeout_s)
        with server:
            server.ehlo()
            if security == "starttls":
                server.starttls(context=context)
                server.ehlo()
            if cfg.smtp_username:
                server.login(cfg.smtp_username, cfg.smtp_password or "")
            server.send_message(msg)
    except (smtplib.SMTPException, OSError) as exc:
        log.warning("e-mail not sent: %s", type(exc).__name__)
        raise DeliveryError("email_not_sent") from exc


# --- SMS ------------------------------------------------------------------------------------


def e164(cfg, phone: str) -> str:
    """Hospital records hold numbers in many forms ("098765 43210", "+91-98765-43210"). Returns
    +<country><number> or raises bad_phone."""
    raw = phone.strip()
    digits = re.sub(r"\D", "", raw)
    if raw.startswith("+"):
        out = "+" + digits
    elif raw.startswith("00"):
        out = "+" + digits[2:]
    else:
        cc = cfg.sms_default_country_code.lstrip("+")
        national = digits.lstrip("0")
        out = "+" + (national if national.startswith(cc) and len(national) > 10 else cc + national)
    if not E164.match(out):
        raise DeliveryError("bad_phone")
    return out


#: Replaced in tests.
http_post = httpx.post


def send_sms_via(cfg, to: str, body: str, template: str) -> None:
    """`template` names the message ("patientInviteSms", "reminderSms") for DLT registration in
    India: its template ID comes from sms_dlt_template_ids."""
    number = e164(cfg, to)
    dlt = json.loads(cfg.sms_dlt_template_ids or "{}")
    provider = cfg.sms_provider
    try:
        if provider == "twilio":
            if not (cfg.twilio_account_sid and cfg.twilio_auth_token):
                raise DeliveryError("not_configured")
            data = {"To": number, "Body": body}
            if cfg.twilio_messaging_service_sid:
                data["MessagingServiceSid"] = cfg.twilio_messaging_service_sid
            elif cfg.sms_from:
                data["From"] = cfg.sms_from
            else:
                raise DeliveryError("not_configured")
            r = http_post(
                f"https://api.twilio.com/2010-04-01/Accounts/{cfg.twilio_account_sid}/Messages.json",
                data=data,
                auth=(cfg.twilio_account_sid, cfg.twilio_auth_token),
                timeout=cfg.sms_timeout_s,
            )
            if r.status_code >= 300:
                raise DeliveryError("sms_not_sent")
        elif provider == "sns":
            import boto3

            attrs = {"AWS.SNS.SMS.SMSType": {"DataType": "String", "StringValue": "Transactional"}}
            if cfg.sms_from:
                attrs["AWS.SNS.SMS.SenderID"] = {"DataType": "String", "StringValue": cfg.sms_from}
            if cfg.sms_dlt_entity_id:
                attrs["AWS.MM.SMS.EntityId"] = {"DataType": "String", "StringValue": cfg.sms_dlt_entity_id}
            if dlt.get(template):
                attrs["AWS.MM.SMS.TemplateId"] = {"DataType": "String", "StringValue": dlt[template]}
            boto3.client("sns", region_name=cfg.sms_aws_region).publish(
                PhoneNumber=number, Message=body, MessageAttributes=attrs
            )
        elif provider == "http":
            # Any SMS gateway (MSG91, Gupshup, Kaleyra, a hospital's own) behind a small adapter:
            # POST {"to", "body", "template", "dlt_template_id", "sender"} with a bearer token.
            if not cfg.sms_http_url:
                raise DeliveryError("not_configured")
            headers = {"Authorization": f"Bearer {cfg.sms_http_token}"} if cfg.sms_http_token else {}
            r = http_post(
                cfg.sms_http_url,
                json={
                    "to": number,
                    "body": body,
                    "template": template,
                    "dlt_template_id": dlt.get(template),
                    "dlt_entity_id": cfg.sms_dlt_entity_id,
                    "sender": cfg.sms_from,
                },
                headers=headers,
                timeout=cfg.sms_timeout_s,
            )
            if r.status_code >= 300:
                raise DeliveryError("sms_not_sent")
        else:
            raise DeliveryError("not_configured")
    except DeliveryError:
        raise
    except Exception as exc:  # network, provider SDK
        log.warning("SMS not sent: %s", type(exc).__name__)
        raise DeliveryError("sms_not_sent") from exc


# --- Start-up check -------------------------------------------------------------------------


def check_config(cfg) -> None:
    """Fails at start-up (not on the first invite) when a provider is chosen but not set up."""
    problems = []
    if cfg.email_provider not in ("dummy", "smtp"):
        problems.append(f"email_provider must be dummy or smtp, not {cfg.email_provider!r}")
    if cfg.email_provider == "smtp":
        if not cfg.smtp_host:
            problems.append("smtp_host is required")
        if not cfg.mail_from:
            problems.append("mail_from is required")
        if cfg.smtp_security not in ("starttls", "ssl", "none"):
            problems.append("smtp_security must be starttls, ssl or none")
        if cfg.smtp_username and not cfg.smtp_password:
            problems.append("smtp_password is required with smtp_username")
    if cfg.sms_provider not in ("dummy", "twilio", "sns", "http"):
        problems.append(f"sms_provider must be dummy, twilio, sns or http, not {cfg.sms_provider!r}")
    if cfg.sms_provider == "twilio" and not (
        cfg.twilio_account_sid
        and cfg.twilio_auth_token
        and (cfg.twilio_messaging_service_sid or cfg.sms_from)
    ):
        problems.append(
            "twilio needs twilio_account_sid, twilio_auth_token and sms_from or a messaging service"
        )
    if cfg.sms_provider == "http" and not cfg.sms_http_url:
        problems.append("sms_http_url is required")
    try:
        if not isinstance(json.loads(cfg.sms_dlt_template_ids or "{}"), dict):
            raise ValueError
    except ValueError:
        problems.append('sms_dlt_template_ids must be JSON like {"patientInviteSms": "1207…"}')
    if problems:
        raise ValueError("message delivery settings: " + "; ".join(problems))
