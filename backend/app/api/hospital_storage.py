"""Hospital storage settings (PLATFORM_PLAN M12, decisions 037, 044). NeuroCapture stores no videos:
each hospital connects its own S3 bucket (an upload-only IAM role that trusts the platform with a
hospital-specific ExternalId) or its own Azure Blob container (a write-only role given to
NeuroCapture's app in the hospital's Microsoft Entra tenant). Until one passes its test, the
hospital cannot record. `dev` is a development storage for tests and the local demo stack only."""

import secrets
from datetime import UTC, datetime
from typing import Literal

import httpx
from azure.core.exceptions import ClientAuthenticationError, HttpResponseError
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session as DbSession

from app.audit import audit
from app.config import get_settings
from app.db import get_db
from app.models import Site
from app.permissions import require
from app.security import Principal, require_role
from app.storage.sites import (
    clear_cache,
    location_for,
    role_permissions_policy,
    role_trust_policy,
    storage_at,
)

router = APIRouter(prefix="/hospital/storage", tags=["hospital"])
perm_setup_connections = require("setup.connections")
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


class AzureIn(BaseModel):
    account: str = Field(min_length=3, max_length=24, pattern=r"^[a-z0-9]+$")
    container: str = Field(min_length=3, max_length=63, pattern=r"^[a-z0-9][a-z0-9-]+[a-z0-9]$")
    #: The hospital's Microsoft Entra tenant (directory) ID.
    tenant_id: str = Field(
        pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
    )
    prefix: str = Field(default="neurocapture/", max_length=200)
    #: Only for sovereign clouds: https://<account>.blob.core.<cloud suffix>
    endpoint: str | None = Field(default=None, max_length=300, pattern=r"^https?://\S+$")

    @field_validator("prefix")
    @classmethod
    def _prefix(cls, v: str) -> str:
        if v and (not v.endswith("/") or v.startswith("/") or ".." in v):
            raise ValueError("prefix must be empty or like 'folder/sub/'")
        return v

    @field_validator("container")
    @classmethod
    def _container(cls, v: str) -> str:
        if "--" in v:
            raise ValueError("container names cannot contain '--'")
        return v


class StorageIn(BaseModel):
    kind: Literal["s3", "azure", "dev"]
    s3: S3In | None = None
    azure: AzureIn | None = None


def azure_role_definition() -> dict:
    """Custom role the hospital creates and assigns to NeuroCapture's app on its container: write
    blobs (stage and commit blocks), nothing else: no read, list or delete."""
    return {
        "Name": "NeuroCapture recording uploader",
        "IsCustom": True,
        "Description": "Upload NeuroCapture recordings (encrypted on the phone). No read, list or delete.",
        "Actions": [],
        "NotActions": [],
        "DataActions": [
            "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write",
            "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/add/action",
        ],
        "NotDataActions": [],
        "AssignableScopes": ["/subscriptions/<subscription-id>"],
    }


class StorageOut(BaseModel):
    #: none (not connected: no recording) | s3 | azure | dev
    kind: str
    #: Decision 044: true once the hospital's own storage passed its test.
    can_record: bool = False
    #: Kinds this platform offers: s3 always; azure when NeuroCapture's Azure app is registered;
    #: dev only on test servers (NC_DEV_STORAGE=true).
    offered: list[str] = []
    s3: dict | None
    external_id: str | None
    #: What the hospital puts on its IAM role: trust policy and (narrow) permissions policy.
    trust_policy: dict | None
    permissions_policy: dict | None
    check: dict | None
    checked_at: datetime | None
    #: Azure: the hospital's settings and what to set up in its tenant (decision 037).
    azure: dict | None = None
    azure_app_client_id: str | None = None
    azure_consent_url: str | None = None
    azure_role_definition: dict | None = None


def storage_offered() -> list[str]:
    s = get_settings()
    return ["s3"] + (["azure"] if s.azure_client_id else []) + (["dev"] if s.dev_storage else [])


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
    az = site.storage_config if site.storage_kind == "azure" else None
    ext = site.storage_external_id
    app_id = get_settings().azure_client_id
    tenant = az["tenant_id"] if az else "organizations"
    from app.storage.sites import can_record

    return StorageOut(
        kind=site.storage_kind,
        can_record=can_record(site),
        offered=storage_offered(),
        s3=cfg,
        external_id=ext,
        trust_policy=role_trust_policy(ext) if ext else None,
        permissions_policy=role_permissions_policy(cfg["bucket"], cfg.get("prefix", "")) if cfg else None,
        check=site.storage_check,
        checked_at=site.storage_checked_at,
        azure=az,
        azure_app_client_id=app_id,
        azure_consent_url=(
            f"https://login.microsoftonline.com/{tenant}/adminconsent?client_id={app_id}" if app_id else None
        ),
        azure_role_definition=azure_role_definition(),
    )


@router.get("", response_model=StorageOut)
def get_storage_settings(
    p: Principal = Depends(perm_setup_connections),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> StorageOut:
    site = _site(db, p)
    _ensure_external_id(site)
    db.commit()
    return _out(site)


def _check_azure(site: Site) -> dict:
    """Sign in to the hospital's tenant, stage one block (never committed: Azure drops it after 7
    days) through a phone-style SAS URL, and make sure reading is refused."""
    result = {"assume_role": "fail", "upload": "fail", "read_blocked": "unknown"}
    try:
        clear_cache()
        st = storage_at(location_for(site))
        key = f"{site.storage_config.get('prefix', '')}{site.id}/_check/{secrets.token_hex(4)}"
        upload_id = st.create_upload(key)
        url = st.part_url(key, upload_id, 1)  # needs a user delegation key: the sign-in works
        result["assume_role"] = "pass"
        r = check_http.put(url, content=b"neurocapture storage check", timeout=15)
        result["upload"] = "pass" if r.status_code in (200, 201) else "fail"
        try:
            st._blob(key).get_blob_properties()
            result["read_blocked"] = "warn"
        except HttpResponseError as exc:
            result["read_blocked"] = "pass" if exc.status_code == 403 else "warn"
    except (HttpResponseError, ClientAuthenticationError, httpx.HTTPError, KeyError, ValueError):
        pass
    return result


#: Replaced in tests.
check_http = httpx


def _check(site: Site) -> dict:
    """Start and abort a multipart upload with the role; reading back should be refused."""
    if site.storage_kind == "azure":
        return _check_azure(site)
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
    p: Principal = Depends(perm_setup_connections),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> StorageOut:
    """Switch where new recordings go. Earlier uploads stay where they are. Switching to s3 runs the
    check first and is refused unless the role works."""
    site = _site(db, p)
    if body.kind == "dev":
        if not get_settings().dev_storage:
            raise HTTPException(status.HTTP_409_CONFLICT, {"code": "dev_storage_off"})
        site.storage_kind, site.storage_config = "dev", None
        site.storage_check, site.storage_checked_at = {"upload": "pass"}, datetime.now(UTC)
    elif body.kind == "azure":
        if body.azure is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "azure_settings_required"})
        if not get_settings().azure_client_id:
            raise HTTPException(status.HTTP_409_CONFLICT, {"code": "azure_not_offered"})
        previous = (site.storage_kind, site.storage_config)
        site.storage_kind, site.storage_config = "azure", body.azure.model_dump(exclude_none=True)
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
def check_storage(
    p: Principal = Depends(perm_setup_connections), db: DbSession = Depends(get_db)
) -> StorageOut:  # noqa: B008
    site = _site(db, p)
    if site.storage_kind not in ("s3", "azure"):
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "storage_not_connected"})
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
