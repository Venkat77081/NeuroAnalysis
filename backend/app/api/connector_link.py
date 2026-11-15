"""Platform <-> hospital connector (PLATFORM_PLAN M11, decision 025, contracts/connector-api.yaml).

- Hospital admins register their connector (address + Ed25519 public key) and run its health
  check; doctors and hospital admins get short-lived connector tokens for their browser.
- The connector calls /connector/v1/* with signed requests to create NCIDs and invites, read app
  status by NCID and fetch encrypted takes. Nothing sent here identifies a patient.
"""

import json
from datetime import UTC, datetime, timedelta
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.audit import audit
from app.config import get_settings
from app.db import get_db
from app.models import Patient, PatientAccount, Session, Site, Take, TakeFile
from app.policy import policy
from app.security import Principal, new_secret, require_role, sha256_hex
from app.signing import (
    NONCES,
    connector_token,
    load_public_pem,
    platform_key,
    platform_public_pem,
    sign_headers,
    verify_signed,
)
from app.storage import get_storage

router = APIRouter(tags=["connector"])

#: Tests inject an httpx.Client (e.g. a TestClient of the connector app); production uses a fresh one.
CONNECTOR_CLIENT: httpx.Client | None = None


class PlatformKeyOut(BaseModel):
    key_id: str
    algorithm: str = "Ed25519"
    public_key_pem: str


@router.get("/.well-known/neurocapture-platform-key", response_model=PlatformKeyOut)
def platform_public_key() -> PlatformKeyOut:
    return PlatformKeyOut(key_id=get_settings().platform_key_id, public_key_pem=platform_public_pem())


# --- Hospital admin: register and test the connector ---

hospital_admin = require_role("hospital_admin")


class ConnectorIn(BaseModel):
    url: str = Field(min_length=8, max_length=300, pattern=r"^https?://[^\s]+$")
    public_key_pem: str = Field(min_length=40, max_length=2000)


class ConnectorOut(BaseModel):
    url: str | None
    registered: bool
    check: dict | None
    checked_at: datetime | None


def _conn_out(site: Site) -> ConnectorOut:
    return ConnectorOut(
        url=site.connector_url,
        registered=bool(site.connector_public_key),
        check=site.connector_check,
        checked_at=site.connector_checked_at,
    )


def _my_site(db: DbSession, p: Principal) -> Site:
    site = db.get(Site, p.site_id) if p.site_id else None
    if not site:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "hospital not found")
    return site


@router.get("/hospital/connector", response_model=ConnectorOut)
def get_connector(p: Principal = Depends(hospital_admin), db: DbSession = Depends(get_db)) -> ConnectorOut:  # noqa: B008
    return _conn_out(_my_site(db, p))


@router.put("/hospital/connector", response_model=ConnectorOut)
def register_connector(
    body: ConnectorIn,
    p: Principal = Depends(hospital_admin),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> ConnectorOut:
    if load_public_pem(body.public_key_pem) is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "not_an_ed25519_key"})
    site = _my_site(db, p)
    site.connector_url = body.url.rstrip("/")
    site.connector_public_key = body.public_key_pem.strip()
    site.connector_check = None
    site.connector_checked_at = None
    audit(db, p.actor_type, p.actor_id, "connector_registered", "site", site.id, site_id=site.id)
    db.commit()
    return _conn_out(site)


class CheckIn(BaseModel):
    #: One MRN the hospital chose for the records test. Sent to the connector only, never stored.
    sample_mrn: str | None = Field(default=None, max_length=64)


CHECK_KEYS = ("records", "ncid_map", "activity_log", "decrypt_key")


def call_connector(site: Site, method: str, path: str, payload: dict | None = None) -> httpx.Response:
    """Signed request from the platform to a hospital's connector."""
    if not site.connector_url:
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "connector_not_registered"})
    body = json.dumps(payload or {}).encode()
    headers = sign_headers(platform_key(), "platform", method, path, body)
    headers["Content-Type"] = "application/json"
    url = site.connector_url + path
    if CONNECTOR_CLIENT is not None:
        return CONNECTOR_CLIENT.request(method, url, content=body, headers=headers)
    with httpx.Client(timeout=get_settings().connector_timeout_s) as client:
        return client.request(method, url, content=body, headers=headers)


@router.post("/hospital/connector/check", response_model=ConnectorOut)
def check_connector(
    body: CheckIn,
    p: Principal = Depends(hospital_admin),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> ConnectorOut:
    """The onboarding wizard's test. NeuroCapture keeps pass / fail per check, nothing else."""
    site = _my_site(db, p)
    try:
        r = call_connector(site, "POST", "/v1/health/check", {"sample_mrn": body.sample_mrn})
        data = r.json() if r.status_code == 200 else {}
        result = {k: ("pass" if data.get(k) == "pass" else "fail") for k in CHECK_KEYS}
        result["reachable"] = "pass" if r.status_code == 200 else "fail"
    except httpx.HTTPError:
        result = {"reachable": "fail", **{k: "fail" for k in CHECK_KEYS}}
    site.connector_check = result
    site.connector_checked_at = datetime.now(UTC)
    audit(db, p.actor_type, p.actor_id, "connector_checked", "site", site.id, site_id=site.id, **result)
    db.commit()
    return _conn_out(site)


class ConnectorTokenOut(BaseModel):
    token: str
    expires_in: int
    connector_url: str


@router.post("/hospital/connector-token", response_model=ConnectorTokenOut)
def get_connector_token(
    p: Principal = Depends(require_role("hospital_admin", "doctor")),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> ConnectorTokenOut:
    """For the browser to call the hospital's connector directly (patient identity never comes here)."""
    site = _my_site(db, p)
    if not site.connector_url or not site.connector_public_key:
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "connector_not_registered"})
    token, ttl = connector_token(site.id, p.actor_id, p.role)
    return ConnectorTokenOut(token=token, expires_in=ttl, connector_url=site.connector_url)


# --- Connector -> platform (signed) ---


async def signed_connector(request: Request, db: DbSession = Depends(get_db)) -> Site:  # noqa: B008
    site_id = request.headers.get("x-nc-key", "")
    site = db.get(Site, site_id) if site_id else None
    public = load_public_pem(site.connector_public_key) if site and site.connector_public_key else None
    path = request.url.path + (f"?{request.url.query}" if request.url.query else "")
    body = await request.body()
    window = get_settings().signature_window_s
    if (
        not site
        or not public
        or not verify_signed(public, request.method, path, request.headers, body, window, NONCES)
    ):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad connector signature")
    if site.status == "suspended":
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "hospital_suspended"})
    return site


class NewPatientIn(BaseModel):
    #: none = NCID only (clinic sessions); otherwise an app invite the connector will deliver.
    channel: Literal["email", "sms", "print", "none"] = "email"


class NewPatientOut(BaseModel):
    ncid: str
    invite_link: str | None = None
    expires_at: datetime | None = None
    app_status: str | None = None


def _invite(acc: PatientAccount, channel: str) -> tuple[str, datetime]:
    token = new_secret()
    exp = datetime.now(UTC) + timedelta(days=policy()["invites"]["patientTtlDays"])
    acc.invite_token_hash = sha256_hex(token)
    acc.invite_expires_at = exp
    acc.invite_channel = channel
    acc.status = "invited"
    return get_settings().invite_link_base + token, exp


def _check_channel(site: Site, channel: str) -> None:
    if channel == "none":
        return
    if not (site.modules or {}).get("home", True):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "home_recording_off"})
    if channel == "sms" and not site.sms_enabled:
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "sms_not_enabled"})


@router.post("/connector/v1/patients", response_model=NewPatientOut, status_code=201)
def connector_new_patient(
    body: NewPatientIn,
    site: Site = Depends(signed_connector),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> NewPatientOut:
    _check_channel(site, body.channel)
    patient = Patient(site_id=site.id)
    db.add(patient)
    db.flush()
    out = NewPatientOut(ncid=patient.ncid)
    if body.channel != "none":
        acc = PatientAccount(site_id=site.id, patient_id=patient.id, created_by="connector")
        db.add(acc)
        out.invite_link, out.expires_at = _invite(acc, body.channel)
        out.app_status = acc.status
    audit(
        db,
        "connector",
        site.id,
        "patient_created",
        "patient",
        patient.id,
        site_id=site.id,
        channel=body.channel,
    )
    db.commit()
    return out


def _patient(db: DbSession, site: Site, ncid: str) -> Patient:
    patient = db.scalar(select(Patient).where(Patient.ncid == ncid, Patient.site_id == site.id))
    if not patient:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown NCID")
    return patient


class InviteIn(BaseModel):
    channel: Literal["email", "sms", "print"] = "email"


@router.post("/connector/v1/patients/{ncid}/invite", response_model=NewPatientOut)
def connector_invite(
    ncid: str,
    body: InviteIn,
    site: Site = Depends(signed_connector),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> NewPatientOut:
    """Invite (or re-invite) an existing NCID: a new single-use link; an earlier phone stops working."""
    from app.api.hospital import end_patient_phone

    _check_channel(site, body.channel)
    patient = _patient(db, site, ncid)
    acc = db.scalar(select(PatientAccount).where(PatientAccount.patient_id == patient.id))
    if acc and acc.status == "closed":
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "account_closed"})
    if not acc:
        acc = PatientAccount(site_id=site.id, patient_id=patient.id, created_by="connector")
        db.add(acc)
    else:
        end_patient_phone(db, acc)
    link, exp = _invite(acc, body.channel)
    audit(
        db,
        "connector",
        site.id,
        "patient_invited",
        "patient",
        patient.id,
        site_id=site.id,
        channel=body.channel,
    )
    db.commit()
    return NewPatientOut(ncid=ncid, invite_link=link, expires_at=exp, app_status=acc.status)


class StatusIn(BaseModel):
    ncids: list[str] = Field(max_length=500)


@router.post("/connector/v1/patients/status", response_model=dict[str, str])
def connector_status(
    body: StatusIn,
    site: Site = Depends(signed_connector),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> dict[str, str]:
    """App status per NCID (invited / active / locked / closed / no_app); unknown NCIDs are left out."""
    rows = db.execute(
        select(Patient.ncid, PatientAccount.status)
        .outerjoin(PatientAccount, PatientAccount.patient_id == Patient.id)
        .where(Patient.site_id == site.id, Patient.ncid.in_(body.ncids))
    )
    return {ncid: st or "no_app" for ncid, st in rows}


class RecordingOut(BaseModel):
    take_id: str
    session_id: str
    started_at: datetime
    recorded_by: str
    med_state: str
    test_code: str
    side: str | None
    capture_verdict: str
    flagged_for_review: bool
    status: str


@router.get("/connector/v1/patients/{ncid}/takes", response_model=list[RecordingOut])
def connector_takes(
    ncid: str,
    site: Site = Depends(signed_connector),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> list[RecordingOut]:
    patient = _patient(db, site, ncid)
    q = (
        select(Take, Session)
        .join(Session, Session.id == Take.session_id)
        .where(Session.patient_id == patient.id)
        .order_by(Session.started_at.desc(), Take.test_code)
    )
    return [
        RecordingOut(
            take_id=t.id,
            session_id=s.id,
            started_at=s.started_at,
            recorded_by=s.recorded_by,
            med_state=s.med_state,
            test_code=t.test_code,
            side=t.side,
            capture_verdict=t.capture_verdict,
            flagged_for_review=t.flagged_for_review,
            status=t.status,
        )
        for t, s in db.execute(q)
    ]


class TakeFileOut(BaseModel):
    kind: str
    url: str
    sha256: str
    size_bytes: int


class TakeDownloadOut(BaseModel):
    take_id: str
    client_take_id: str
    ncid: str
    test_code: str
    key_id: str
    wrapped_data_key: str
    files: list[TakeFileOut]


@router.get("/connector/v1/takes/{take_id}", response_model=TakeDownloadOut)
def connector_take(
    take_id: str,
    site: Site = Depends(signed_connector),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> TakeDownloadOut:
    """Encrypted files of one complete take, with short-lived download links. Only this hospital's
    connector can unwrap the data key."""
    take = db.get(Take, take_id)
    sess = db.get(Session, take.session_id) if take else None
    patient = db.get(Patient, sess.patient_id) if sess else None
    if not take or not sess or not patient or patient.site_id != site.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "take not found")
    if take.status != "complete":
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "upload_not_complete"})
    st = get_storage()
    ttl = get_settings().upload_url_ttl_s
    files = [
        TakeFileOut(
            kind=f.kind, url=st.download_url(f.object_key, ttl), sha256=f.sha256, size_bytes=f.size_bytes
        )
        for f in db.scalars(select(TakeFile).where(TakeFile.take_id == take.id))
    ]
    audit(db, "connector", site.id, "take_fetched", "take", take.id, site_id=site.id)
    db.commit()
    return TakeDownloadOut(
        take_id=take.id,
        client_take_id=take.client_take_id,
        ncid=patient.ncid,
        test_code=take.test_code,
        key_id=take.key_id,
        wrapped_data_key=take.wrapped_data_key,
        files=files,
    )
