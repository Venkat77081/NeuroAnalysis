"""E-mail and SMS settings entered by the hospital admin in the dashboard (decision 042).

- Stored here only, encrypted (AES-256-GCM). The key is derived (HKDF) from this connector's
  signing key, so a copy of the database alone cannot be read.
- Values set in the connector's environment (NCC_SMTP_*, NCC_SMS_*, ...) always win; the
  dashboard shows them as "set by IT" and cannot change them.
- Passwords, tokens and keys are never returned: only whether they are set.
- The platform learns only "working / failing / off" per channel.
"""

import base64
import json
import os
from datetime import UTC, datetime

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from sqlalchemy.orm import Session as DbSession

from ncconnector.config import Settings, get_settings
from ncconnector.db import MessagingSettings
from ncconnector.keys import signing_key

#: Dashboard field → connector setting. Secrets are write-only.
EMAIL_FIELDS = {
    "host": "smtp_host",
    "port": "smtp_port",
    "security": "smtp_security",
    "username": "smtp_username",
    "password": "smtp_password",
    "from": "mail_from",
    "from_name": "mail_from_name",
}
SMS_FIELDS = {
    "provider": "sms_provider",
    "from": "sms_from",
    "country_code": "sms_default_country_code",
    "dlt_entity_id": "sms_dlt_entity_id",
    "dlt_template_ids": "sms_dlt_template_ids",
    "account_sid": "twilio_account_sid",
    "auth_token": "twilio_auth_token",
    "messaging_service_sid": "twilio_messaging_service_sid",
    "aws_region": "sms_aws_region",
    "http_url": "sms_http_url",
    "http_token": "sms_http_token",
}
SECRETS = {"password", "auth_token", "http_token"}


def _key() -> bytes:
    raw = signing_key().private_bytes(
        serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()
    )
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=b"nc-messaging-settings-v1").derive(raw)


def seal(doc: dict) -> str:
    nonce = os.urandom(12)
    ct = AESGCM(_key()).encrypt(nonce, json.dumps(doc).encode(), b"nc_messaging_settings")
    return base64.b64encode(nonce + ct).decode()


def unseal(sealed: str) -> dict:
    raw = base64.b64decode(sealed)
    return json.loads(AESGCM(_key()).decrypt(raw[:12], raw[12:], b"nc_messaging_settings"))


def stored(db: DbSession) -> tuple[dict, MessagingSettings | None]:
    row = db.get(MessagingSettings, "default")
    if row is None:
        return {"email": {}, "sms": {}}, None
    try:
        return unseal(row.sealed), row
    except Exception:  # key changed (new signing key): the admin enters the settings again
        return {"email": {}, "sms": {}}, row


def _from_env(field: str) -> bool:
    """Set by IT (environment or .env): the value differs from the built-in default. A value IT
    sets equal to the default (e.g. port 587) can still be changed in the dashboard."""
    return getattr(get_settings(), field) != Settings.model_fields[field].default


def effective(db: DbSession) -> Settings:
    """The connector's settings with the dashboard's values filled in where IT set nothing."""
    s = get_settings()
    doc, _ = stored(db)
    update: dict = {}
    for group, fields in (("email", EMAIL_FIELDS), ("sms", SMS_FIELDS)):
        for k, field in fields.items():
            v = doc.get(group, {}).get(k)
            if v not in (None, "") and not _from_env(field):
                update[field] = v
    if doc.get("email", {}).get("host") and not _from_env("email_provider"):
        update["email_provider"] = "smtp"
    if doc.get("sms", {}).get("provider") == "off" and not _from_env("sms_provider"):
        update["sms_provider"] = "dummy"
    return s.model_copy(update=update) if update else s


def view(db: DbSession) -> dict:
    """What the dashboard shows: values (secrets as set / not set), and which come from IT."""
    doc, row = stored(db)
    eff = effective(db)
    out: dict = {}
    for group, fields in (("email", EMAIL_FIELDS), ("sms", SMS_FIELDS)):
        values: dict = {}
        locked = []
        for k, field in fields.items():
            v = getattr(eff, field)
            if _from_env(field):
                locked.append(k)
            values[k] = bool(v) if k in SECRETS else v
        if group == "sms":
            values["provider"] = "off" if eff.sms_provider == "dummy" else eff.sms_provider
        out[group] = {"values": values, "set_by_it": locked}
    out["email"]["on"] = eff.email_provider == "smtp"
    out["sms"]["on"] = eff.sms_provider != "dummy"
    out["tests"] = (row.tests if row else None) or {}
    out["updated_at"] = row.updated_at.isoformat() if row else None
    return out


def save(db: DbSession, user_id: str, email: dict | None, sms: dict | None) -> list[str]:
    """Merge the admin's changes. Secrets: None keeps the stored value, "" clears it. Returns the
    names of the fields that changed (for the activity log; never the values)."""
    doc, row = stored(db)
    changed = []
    for group, body, fields in (("email", email, EMAIL_FIELDS), ("sms", sms, SMS_FIELDS)):
        if body is None:
            continue
        cur = doc.setdefault(group, {})
        for k in fields:
            if k not in body or _from_env(fields[k]):
                continue
            v = body[k]
            if k in SECRETS and v is None:
                continue
            if cur.get(k) != v:
                cur[k] = v
                changed.append(f"{group}.{k}")
    if row is None:
        row = MessagingSettings(id="default", sealed=seal(doc), tests={})
        db.add(row)
    else:
        row.sealed = seal(doc)
        if changed:  # an old test result no longer says anything about the new settings
            groups = {c.split(".")[0] for c in changed}
            row.tests = {k: v for k, v in (row.tests or {}).items() if k.split("_")[0] not in groups}
    row.updated_by, row.updated_at = user_id, datetime.now(UTC)
    db.commit()
    return changed


def record_test(db: DbSession, channel: str, ok: bool) -> dict:
    _, row = stored(db)
    if row is None:
        row = MessagingSettings(id="default", sealed=seal({"email": {}, "sms": {}}), tests={})
        db.add(row)
    tests = dict(row.tests or {})
    tests[channel] = "working" if ok else "failing"
    tests[f"{channel}_at"] = datetime.now(UTC).isoformat()
    row.tests = tests
    db.commit()
    return tests


def status(db: DbSession) -> dict[str, str]:
    """working / failing / off per channel, as the platform learns it."""
    eff = effective(db)
    _, row = stored(db)
    tests = (row.tests if row else None) or {}
    on = {"email": eff.email_provider == "smtp", "sms": eff.sms_provider != "dummy"}
    return {ch: (tests.get(ch, "working") if on[ch] else "off") for ch in ("email", "sms")}
