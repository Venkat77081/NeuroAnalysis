"""Hospital storage settings (PLATFORM_PLAN M12): NeuroCapture-managed, or the hospital's own S3
bucket through an upload-only IAM role that trusts the platform with a hospital-specific ExternalId."""

import secrets
from datetime import UTC, datetime
from typing import Literal

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session as DbSession

from app.audit import audit
from app.db import get_db
from app.models import Site
from app.security import Principal, require_role
from app.storage.sites import (
    clear_cache,
    location_for,
    role_permissions_policy,
    role_trust_policy,
    storage_at,
)

router = APIRouter(prefix="/hospital/storage", tags=["hospital"])
hospital_admin = require_role("hospital_admin")


class S3In(BaseModel):
    bucket: str = Field(min_length=3, max_length=63, pattern=r"^[a-z0-9][a-z0-9.\-]+[a-z0-9]$")
    region: str = Field(min_length=2, max_length=30)
    role_arn: str = Field(pattern=r"^arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_\-/]+$")
    #: Must end with "/" (or be empty): the role may only write below it.
    prefix: str = Field(default="neurocapture/", max_length=200)
    endpoint: str | None = Field(default=None, max_length=300, pattern=r"^https?://\S+$")
    kms_key_id: str | None = Field(default=None, max_length=300)

    @field_validator("prefix")
    @classmethod
    def _prefix(cls, v: str) -> str:
        if v and (not v.endswith("/") or v.startswith("/") or ".." in v):
            raise ValueError("prefix must be empty or like 'folder/sub/'")
        return v


class StorageIn(BaseModel):
    kind: Literal["managed", "s3"]
    s3: S3In | None = None


class StorageOut(BaseModel):
    kind: str
    s3: dict | None
    external_id: str | None
    #: What the hospital puts on its IAM role: trust policy and (narrow) permissions policy.
    trust_policy: dict | None
    permissions_policy: dict | None
    check: dict | None
    checked_at: datetime | None


def _site(db: DbSession, p: Principal) -> Site:
    site = db.get(Site, p.site_id) if p.site_id else None
    if not site:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "hospital not found")
    return site


def _ensure_external_id(site: Site) -> str:
    if not site.storage_external_id:
        site.storage_external_id = "nc-" + secrets.token_hex(16)
    return site.storage_external_id


def _out(site: Site) -> StorageOut:
    cfg = site.storage_config if site.storage_kind == "s3" else None
    ext = site.storage_external_id
    return StorageOut(
        kind=site.storage_kind,
        s3=cfg,
        external_id=ext,
        trust_policy=role_trust_policy(ext) if ext else None,
        permissions_policy=role_permissions_policy(cfg["bucket"], cfg.get("prefix", "")) if cfg else None,
        check=site.storage_check,
        checked_at=site.storage_checked_at,
    )


@router.get("", response_model=StorageOut)
def get_storage_settings(
    p: Principal = Depends(hospital_admin),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> StorageOut:
    site = _site(db, p)
    _ensure_external_id(site)
    db.commit()
    return _out(site)


def _check(site: Site) -> dict:
    """Start and abort a multipart upload with the role; reading back should be refused."""
    loc = location_for(site)
    result = {"assume_role": "fail", "upload": "fail", "read_blocked": "unknown"}
    try:
        clear_cache()
        st = storage_at(loc)
        result["assume_role"] = "pass"
        key = f"{(site.storage_config or {}).get('prefix', '')}{site.id}/_check/{secrets.token_hex(4)}"
        upload_id = st.create_upload(key)
        st.list_parts(key, upload_id)
        st.abort(key, upload_id)
        result["upload"] = "pass"
        try:
            st.s3.get_object(Bucket=st.bucket, Key=key)
            result["read_blocked"] = "warn"
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "")
            result["read_blocked"] = "pass" if code in ("AccessDenied", "403") else "warn"
    except (BotoCoreError, ClientError, KeyError, ValueError):
        pass
    return result


@router.put("", response_model=StorageOut)
def set_storage_settings(
    body: StorageIn,
    p: Principal = Depends(hospital_admin),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> StorageOut:
    """Switch where new recordings go. Earlier uploads stay where they are. Switching to s3 runs the
    check first and is refused unless the role works."""
    site = _site(db, p)
    if body.kind == "managed":
        site.storage_kind = "managed"
        site.storage_check = None
    else:
        if body.s3 is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "s3_settings_required"})
        _ensure_external_id(site)
        previous = (site.storage_kind, site.storage_config)
        site.storage_kind, site.storage_config = "s3", body.s3.model_dump(exclude_none=True)
        result = _check(site)
        site.storage_check, site.storage_checked_at = result, datetime.now(UTC)
        if result["upload"] != "pass":
            site.storage_kind, site.storage_config = previous
            audit(
                db,
                p.actor_type,
                p.actor_id,
                "storage_check_failed",
                "site",
                site.id,
                site_id=site.id,
                **result,
            )
            db.commit()
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "storage_check_failed", **result}
            )
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "storage_changed",
        "site",
        site.id,
        site_id=site.id,
        kind=site.storage_kind,
    )
    db.commit()
    return _out(site)


@router.post("/check", response_model=StorageOut)
def check_storage(p: Principal = Depends(hospital_admin), db: DbSession = Depends(get_db)) -> StorageOut:  # noqa: B008
    site = _site(db, p)
    if site.storage_kind != "s3":
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "managed_storage"})
    site.storage_check, site.storage_checked_at = _check(site), datetime.now(UTC)
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "storage_checked",
        "site",
        site.id,
        site_id=site.id,
        **site.storage_check,
    )
    db.commit()
    return _out(site)
