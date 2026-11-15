"""Hospital take keys (PLATFORM_PLAN M12, decision 026). The platform stores public keys only."""

import hashlib
import secrets
from datetime import UTC, datetime

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.config import get_settings
from app.keys import server_public_key
from app.models import Site, SiteKey


def fingerprint(pub: rsa.RSAPublicKey) -> str:
    der = pub.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return hashlib.sha256(der).hexdigest()


def parse_public_key(pem: str) -> rsa.RSAPublicKey:
    try:
        key = serialization.load_pem_public_key(pem.encode())
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "not_a_public_key"}) from exc
    if not isinstance(key, rsa.RSAPublicKey) or key.key_size < get_settings().min_take_key_bits:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "rsa_3072_or_larger_required"})
    return key


def active_key(db: DbSession, site_id: str) -> SiteKey | None:
    return db.scalar(select(SiteKey).where(SiteKey.site_id == site_id, SiteKey.status == "active"))


def register_key(db: DbSession, site: Site, pem: str) -> tuple[SiteKey, SiteKey | None]:
    """New active key; the previous one is retired (still valid for sessions that already have it)."""
    pub = parse_public_key(pem)
    fp = fingerprint(pub)
    existing = db.scalar(select(SiteKey).where(SiteKey.site_id == site.id, SiteKey.fingerprint == fp))
    if existing:
        raise HTTPException(
            status.HTTP_409_CONFLICT, {"code": "key_already_registered", "key_id": existing.id}
        )
    old = active_key(db, site.id)
    if old:
        old.status = "retired"
        old.retired_at = datetime.now(UTC)
    key = SiteKey(
        id=f"hk-{secrets.token_hex(8)}", site_id=site.id, public_key_pem=pem.strip(), fingerprint=fp
    )
    db.add(key)
    db.flush()
    return key, old


def session_key(db: DbSession, site: Site) -> tuple[str, str, str]:
    """(key_id, PEM, owner) the phone must use for a new session."""
    key = active_key(db, site.id)
    if key:
        return key.id, key.public_key_pem, "hospital"
    if get_settings().require_hospital_key:
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "no_hospital_key"})
    key_id, pem = server_public_key()
    return key_id, pem, "platform"
