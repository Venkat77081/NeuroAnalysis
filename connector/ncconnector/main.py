"""Connector HTTP API (contracts/connector-api.yaml)."""

import base64
import hashlib
import logging
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from ncconnector import __version__, activity, platform
from ncconnector.auth import Staff, platform_signed, role
from ncconnector.config import get_settings
from ncconnector.db import ActivityLog, NcidMap, get_db, init_db
from ncconnector.keys import take_private_key
from ncconnector.providers import send_invite
from ncconnector.records import RecordsUnavailableError, records
from ncconnector.takecrypto import FILE_NAMES, decrypt_file, unwrap_data_key

log = logging.getLogger("ncconnector")


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="NeuroCapture hospital connector", version=__version__, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in get_settings().cors_origins.split(",") if o.strip()],
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)

doctor_or_admin = role("doctor", "hospital_admin")
admin = role("hospital_admin")


def _platform_error(exc: platform.PlatformError) -> HTTPException:
    code = exc.status_code if exc.status_code in (403, 404, 409, 422) else 502
    return HTTPException(code, exc.detail or {"code": "platform_error"})


# --- Health ---


class HealthOut(BaseModel):
    status: str
    version: str


@app.get("/health", response_model=HealthOut)
def health() -> HealthOut:
    """Liveness only; reveals nothing about the hospital."""
    return HealthOut(status="ok", version=__version__)


class CheckIn(BaseModel):
    sample_mrn: str | None = Field(default=None, max_length=64)


Result = Literal["pass", "fail"]


class CheckOut(BaseModel):
    records: Result
    ncid_map: Result
    activity_log: Result
    decrypt_key: Result


@app.post("/v1/health/check", response_model=CheckOut, dependencies=[Depends(platform_signed)])
def health_check(body: CheckIn, db: DbSession = Depends(get_db)) -> CheckOut:
    """The onboarding wizard's test, requested by the platform. Answers pass / fail only."""
    try:
        rec = records().get(body.sample_mrn) if body.sample_mrn else None
        records_ok = rec is not None if body.sample_mrn else True
        if body.sample_mrn is None:
            records().search("zz-health-check", 1)
    except RecordsUnavailableError:
        records_ok = False
    try:
        db.scalar(select(NcidMap).limit(1))
        map_ok = True
    except Exception:  # noqa: BLE001 - any database failure is a fail
        map_ok = False
    try:
        activity.write(db, "system", None, "health_check")
        log_ok = True
    except Exception:  # noqa: BLE001
        log_ok = False
    key_ok = take_private_key() is not None
    p = {True: "pass", False: "fail"}
    return CheckOut(records=p[records_ok], ncid_map=p[map_ok], activity_log=p[log_ok], decrypt_key=p[key_ok])


# --- Patients (live from the hospital's records) ---


class PatientRow(BaseModel):
    mrn: str
    name: str
    birth_date: date | None
    sex: str | None
    has_email: bool
    has_phone: bool
    ncid: str | None
    #: invited | active | locked | closed | no_app; null if not linked or the platform is unreachable
    app_status: str | None


def _statuses(ncids: list[str]) -> dict[str, str]:
    if not ncids:
        return {}
    try:
        return platform.call("POST", "/connector/v1/patients/status", {"ncids": ncids})
    except platform.PlatformError:
        return {}


@app.get("/v1/patients", response_model=list[PatientRow])
def search_patients(
    q: str = Query(min_length=2, max_length=100),
    limit: int = Query(25, ge=1, le=100),
    s: Staff = Depends(doctor_or_admin),
    db: DbSession = Depends(get_db),
) -> list[PatientRow]:
    try:
        found = records().search(q, limit)
    except RecordsUnavailableError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, {"code": "records_unavailable"}) from exc
    links = {
        m.mrn: m.ncid for m in db.scalars(select(NcidMap).where(NcidMap.mrn.in_([r.mrn for r in found])))
    }
    statuses = _statuses(list(links.values()))
    activity.write(db, s.role, s.user_id, "patients_searched", results=len(found))
    return [
        PatientRow(
            mrn=r.mrn,
            name=r.name,
            birth_date=r.birth_date,
            sex=r.sex,
            has_email=bool(r.email),
            has_phone=bool(r.phone),
            ncid=links.get(r.mrn),
            app_status=statuses.get(links.get(r.mrn) or ""),
        )
        for r in found
    ]


class HistoryItemOut(BaseModel):
    text: str
    date: str | None = None
    detail: str | None = None


class PatientViewOut(BaseModel):
    ncid: str
    #: False: the hospital system did not answer; identity and history are empty.
    records_available: bool
    mrn: str
    name: str | None = None
    birth_date: date | None = None
    sex: str | None = None
    conditions: list[HistoryItemOut] = []
    medications: list[HistoryItemOut] = []
    encounters: list[HistoryItemOut] = []


def _mrn_for(db: DbSession, ncid: str) -> str:
    m = db.get(NcidMap, ncid)
    if not m:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown NCID")
    return m.mrn


@app.get("/v1/patients/{ncid}", response_model=PatientViewOut)
def patient_view(
    ncid: str, s: Staff = Depends(doctor_or_admin), db: DbSession = Depends(get_db)
) -> PatientViewOut:
    """Doctor view: identity and history read live for this request (never stored)."""
    mrn = _mrn_for(db, ncid)
    activity.write(db, s.role, s.user_id, "history_viewed", ncid)
    try:
        rec = records().get(mrn)
        hist = records().history(mrn) if rec else None
    except RecordsUnavailableError:
        return PatientViewOut(ncid=ncid, mrn=mrn, records_available=False)
    if not rec or not hist:
        return PatientViewOut(ncid=ncid, mrn=mrn, records_available=False)

    def items(xs):
        return [HistoryItemOut(text=x.text, date=x.date, detail=x.detail) for x in xs]

    return PatientViewOut(
        ncid=ncid,
        records_available=True,
        mrn=mrn,
        name=rec.name,
        birth_date=rec.birth_date,
        sex=rec.sex,
        conditions=items(hist.conditions),
        medications=items(hist.medications),
        encounters=items(hist.encounters),
    )


# --- NCIDs and invites ---


class NcidIn(BaseModel):
    mrn: str = Field(min_length=1, max_length=64)


class NcidOut(BaseModel):
    ncid: str
    created: bool


def _ensure_ncid(db: DbSession, mrn: str, by: str, channel: str) -> tuple[str, bool, dict | None]:
    """Existing NCID for the MRN, or a new one from the platform (with an invite unless channel none)."""
    m = db.scalar(select(NcidMap).where(NcidMap.mrn == mrn))
    if m:
        return m.ncid, False, None
    try:
        out = platform.call("POST", "/connector/v1/patients", {"channel": channel})
    except platform.PlatformError as exc:
        raise _platform_error(exc) from exc
    db.add(NcidMap(ncid=out["ncid"], mrn=mrn, created_by=by))
    db.commit()
    return out["ncid"], True, out


@app.post("/v1/ncid", response_model=NcidOut)
def ncid_for_mrn(
    body: NcidIn, s: Staff = Depends(doctor_or_admin), db: DbSession = Depends(get_db)
) -> NcidOut:
    """NCID for a hospital patient (clinic session without an app invite)."""
    mrn = body.mrn.strip()
    try:
        if records().get(mrn) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, {"code": "mrn_not_found"})
    except RecordsUnavailableError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, {"code": "records_unavailable"}) from exc
    ncid, created, _ = _ensure_ncid(db, mrn, s.user_id, "none")
    activity.write(db, s.role, s.user_id, "ncid_created" if created else "ncid_looked_up", ncid)
    return NcidOut(ncid=ncid, created=created)


class InviteIn(BaseModel):
    mrns: list[str] = Field(min_length=1, max_length=200)
    channel: Literal["email", "sms", "print"] = "email"


class InviteResult(BaseModel):
    mrn: str
    #: sent | printed | skipped_no_email | skipped_no_phone | not_found | failed
    result: str
    ncid: str | None = None
    #: Print only: the link and a QR code (PNG, base64) to hand over at the visit.
    invite_link: str | None = None
    qr_png_base64: str | None = None
    error: str | None = None


def _days(expires_at: str) -> int:
    exp = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    return max(1, round((exp - datetime.now(UTC)).total_seconds() / 86400))


def _invite_one(db: DbSession, s: Staff, mrn: str, channel: str) -> InviteResult:
    rec = records().get(mrn)
    if rec is None:
        return InviteResult(mrn=mrn, result="not_found")
    contact = rec.email if channel == "email" else rec.phone if channel == "sms" else None
    if channel == "email" and not contact:
        return InviteResult(mrn=mrn, result="skipped_no_email")
    if channel == "sms" and not contact:
        return InviteResult(mrn=mrn, result="skipped_no_phone")
    try:
        ncid, created, out = _ensure_ncid(db, mrn, s.user_id, channel)
        if not created:
            out = platform.call("POST", f"/connector/v1/patients/{ncid}/invite", {"channel": channel})
    except HTTPException as exc:
        return InviteResult(
            mrn=mrn, result="failed", error=str((exc.detail or {}).get("code", exc.status_code))
        )
    except platform.PlatformError as exc:
        return InviteResult(
            mrn=mrn, result="failed", error=str((exc.detail or {}).get("code", exc.status_code))
        )
    assert out is not None
    link = out["invite_link"]
    activity.write(db, s.role, s.user_id, "patient_invited", ncid, channel=channel)
    if channel == "print":
        from ncconnector.providers import qr_png

        return InviteResult(
            mrn=mrn,
            result="printed",
            ncid=ncid,
            invite_link=link,
            qr_png_base64=base64.b64encode(qr_png(link)).decode(),
        )
    assert contact is not None
    send_invite(channel, contact, link, _days(out["expires_at"]))
    return InviteResult(mrn=mrn, result="sent", ncid=ncid)


@app.post("/v1/invites", response_model=list[InviteResult])
def invite(body: InviteIn, s: Staff = Depends(admin), db: DbSession = Depends(get_db)) -> list[InviteResult]:
    """Invite patients from the hospital's records. Contact details are read live here and handed to
    the hospital's mail / SMS provider; the platform only learns the NCID and the channel."""
    out = []
    for mrn in dict.fromkeys(m.strip() for m in body.mrns):
        try:
            out.append(_invite_one(db, s, mrn, body.channel))
        except RecordsUnavailableError as exc:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, {"code": "records_unavailable"}) from exc
    return out


# --- Recordings ---


@app.get("/v1/patients/{ncid}/recordings")
def recordings(ncid: str, s: Staff = Depends(doctor_or_admin), db: DbSession = Depends(get_db)) -> list[dict]:
    _mrn_for(db, ncid)
    try:
        return platform.call("GET", f"/connector/v1/patients/{ncid}/takes")
    except platform.PlatformError as exc:
        raise _platform_error(exc) from exc


@app.get("/v1/takes/{take_id}/files/{kind}")
def take_file(
    take_id: str,
    kind: Literal["video", "frames", "landmarks", "sensors", "quality", "meta"],
    s: Staff = Depends(doctor_or_admin),
    db: DbSession = Depends(get_db),
) -> Response:
    """Decrypts one file of a take for the doctor's browser (only this connector holds the key)."""
    key = take_private_key()
    if key is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, {"code": "no_take_key"})
    try:
        info = platform.call("GET", f"/connector/v1/takes/{take_id}")
    except platform.PlatformError as exc:
        raise _platform_error(exc) from exc
    if db.get(NcidMap, info["ncid"]) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "take not found")
    f = next((x for x in info["files"] if x["kind"] == kind), None)
    if not f:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "file not in this take")
    try:
        ciphertext = platform.download(f["url"])
    except platform.PlatformError as exc:
        raise _platform_error(exc) from exc
    if hashlib.sha256(ciphertext).hexdigest() != f["sha256"]:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, {"code": "checksum_mismatch"})
    try:
        plain = decrypt_file(
            unwrap_data_key(info["wrapped_data_key"], key), info["client_take_id"], kind, ciphertext
        )
    except Exception as exc:  # noqa: BLE001 - wrong key or corrupt file
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "cannot_decrypt"}) from exc
    activity.write(db, s.role, s.user_id, "recording_viewed", info["ncid"], take_id=take_id, file=kind)
    media = {"video": "video/mp4", "quality": "application/json", "meta": "application/json"}
    return Response(
        plain,
        media_type=media.get(kind, "application/octet-stream"),
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": f'inline; filename="{FILE_NAMES[kind]}"',
        },
    )


# --- Activity log ---


class ActivityIn(BaseModel):
    actor_type: str = Field(max_length=20)
    actor_id: str | None = Field(default=None, max_length=64)
    action: str = Field(max_length=50)
    ncid: str | None = Field(default=None, max_length=40)
    details: dict | None = None


@app.post("/v1/activity", status_code=204, dependencies=[Depends(platform_signed)])
def platform_activity(body: ActivityIn, db: DbSession = Depends(get_db)) -> None:
    """Clinical events the platform sees first (e.g. a home session uploaded), logged at the hospital."""
    activity.write(db, body.actor_type, body.actor_id, body.action, body.ncid, **(body.details or {}))


class ActivityOut(BaseModel):
    at: datetime
    actor_type: str
    actor_id: str | None
    action: str
    ncid: str | None
    details: dict | None


@app.get("/v1/activity", response_model=list[ActivityOut])
def read_activity(
    ncid: str | None = None,
    limit: int = Query(200, ge=1, le=1000),
    s: Staff = Depends(admin),
    db: DbSession = Depends(get_db),
) -> list[ActivityOut]:
    q = select(ActivityLog).order_by(ActivityLog.at.desc()).limit(limit)
    if ncid:
        q = q.where(ActivityLog.ncid == ncid)
    return [
        ActivityOut(
            at=a.at,
            actor_type=a.actor_type,
            actor_id=a.actor_id,
            action=a.action,
            ncid=a.ncid,
            details=a.details,
        )
        for a in db.scalars(q)
    ]
