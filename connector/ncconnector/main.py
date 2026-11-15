"""Connector HTTP API (contracts/connector-api.yaml)."""

import asyncio
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
from ncconnector.db import ActivityLog, NcidMap, Review, get_db, init_db
from ncconnector.keys import has_take_key, take_private_key
from ncconnector.providers import send_invite
from ncconnector.records import RecordsUnavailableError, records
from ncconnector.storage import read_object
from ncconnector.takecrypto import FILE_NAMES, decrypt_file, unwrap_data_key

log = logging.getLogger("ncconnector")


async def _reminder_loop(every_s: int) -> None:
    from ncconnector.db import factory
    from ncconnector.reminders import send_due

    def run() -> None:
        with factory()() as db:
            send_due(db)

    while True:
        try:
            await asyncio.to_thread(run)
        except Exception as exc:  # noqa: BLE001 - next round
            log.warning("reminders failed: %s", type(exc).__name__)
        await asyncio.sleep(every_s)


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    every = get_settings().reminder_interval_s
    task = asyncio.create_task(_reminder_loop(every)) if every else None
    yield
    if task:
        task.cancel()


app = FastAPI(title="NeuroCapture hospital connector", version=__version__, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in get_settings().cors_origins.split(",") if o.strip()],
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)

doctor_or_admin = role("doctor", "hospital_admin")
admin = role("hospital_admin")
desk = role("hospital_admin", "receptionist")
listing = role("doctor", "hospital_admin", "receptionist")
clinic_staff = role("hospital_admin", "receptionist", "operator")
doctor = role("doctor")
#: Medical history, recordings, decrypted videos and review notes: assigned doctors only (user,
#: 15 Nov 2026). Hospital admins and receptionists see names, never clinical data.
clinical = doctor


def allowed(s: Staff, ncids: list[str]) -> set[str]:
    """M14: which of these patients this staff member may see. Doctors: only those assigned to them,
    asked of the platform on every request (a reassignment takes effect at once)."""
    if s.role in ("hospital_admin", "receptionist"):
        return set(ncids)
    if s.role != "doctor" or not ncids:
        return set()
    try:
        out = platform.call("POST", "/connector/v1/access", {"user_id": s.user_id, "ncids": ncids})
    except platform.PlatformError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, {"code": "platform_unreachable"}) from exc
    return set(out["allowed"])


def require_access(s: Staff, ncid: str) -> None:
    if ncid not in allowed(s, [ncid]):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown NCID")


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
    key_ok = has_take_key()
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
    s: Staff = Depends(desk),
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
def patient_view(ncid: str, s: Staff = Depends(clinical), db: DbSession = Depends(get_db)) -> PatientViewOut:
    """Doctor view: identity and history read live for this request (never stored)."""
    mrn = _mrn_for(db, ncid)
    require_access(s, ncid)
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


class LookupIn(BaseModel):
    ncids: list[str] = Field(min_length=1, max_length=200)


class LookupRow(BaseModel):
    ncid: str
    mrn: str
    name: str | None = None
    birth_date: date | None = None
    sex: str | None = None
    #: False: this patient could not be read from the hospital system just now.
    records_available: bool


@app.post("/v1/patients/lookup", response_model=list[LookupRow])
def lookup(body: LookupIn, s: Staff = Depends(listing), db: DbSession = Depends(get_db)) -> list[LookupRow]:
    """M14: names for a list of NCIDs (the platform lists NCIDs; the browser joins identity here,
    live, never stored). Unknown NCIDs are left out."""
    may = allowed(s, list(dict.fromkeys(body.ncids)))
    rows = list(db.scalars(select(NcidMap).where(NcidMap.ncid.in_(may))))
    out = []
    for m in rows:
        try:
            rec = records().get(m.mrn)
        except RecordsUnavailableError:
            rec = None
            out.append(LookupRow(ncid=m.ncid, mrn=m.mrn, records_available=False))
            continue
        out.append(
            LookupRow(
                ncid=m.ncid,
                mrn=m.mrn,
                name=rec.name if rec else None,
                birth_date=rec.birth_date if rec else None,
                sex=rec.sex if rec else None,
                records_available=rec is not None,
            )
        )
    activity.write(db, s.role, s.user_id, "patients_listed", results=len(out))
    return out


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
def ncid_for_mrn(body: NcidIn, s: Staff = Depends(clinic_staff), db: DbSession = Depends(get_db)) -> NcidOut:
    """NCID for a hospital patient (clinic session without an app invite). Clinic phones call this
    with an operator token; the MRN stays inside the hospital."""
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
def invite(body: InviteIn, s: Staff = Depends(desk), db: DbSession = Depends(get_db)) -> list[InviteResult]:
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
def recordings(ncid: str, s: Staff = Depends(clinical), db: DbSession = Depends(get_db)) -> list[dict]:
    _mrn_for(db, ncid)
    require_access(s, ncid)
    try:
        return platform.call("GET", f"/connector/v1/patients/{ncid}/takes")
    except platform.PlatformError as exc:
        raise _platform_error(exc) from exc


@app.get("/v1/takes/{take_id}/files/{kind}")
def take_file(
    take_id: str,
    kind: Literal["video", "frames", "landmarks", "sensors", "quality", "meta"],
    s: Staff = Depends(clinical),
    db: DbSession = Depends(get_db),
) -> Response:
    """Decrypts one file of a take for the doctor's browser (only this connector holds the key)."""
    try:
        info = platform.call("GET", f"/connector/v1/takes/{take_id}")
    except platform.PlatformError as exc:
        raise _platform_error(exc) from exc
    if db.get(NcidMap, info["ncid"]) is None or info["ncid"] not in allowed(s, [info["ncid"]]):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "take not found")
    key = take_private_key(info["key_id"])
    if key is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, {"code": "no_take_key", "key_id": info["key_id"]}
        )
    f = next((x for x in info["files"] if x["kind"] == kind), None)
    if not f:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "file not in this take")
    try:
        ciphertext = read_object(f["location"]) if f.get("location") else platform.download(f["url"])
    except platform.PlatformError as exc:
        raise _platform_error(exc) from exc
    ok = hashlib.sha256(ciphertext).hexdigest() == f["sha256"]
    if f.get("checksum_verified") is None:
        # Hospital bucket: the platform could not read the file; report the check (M12).
        try:
            platform.call("POST", f"/connector/v1/takes/{take_id}/files/{kind}/verified", {"ok": ok})
        except platform.PlatformError:
            log.warning("could not report checksum result")
    if not ok:
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


# --- Appointments (v3): live from the hospital's system ---


class AppointmentRow(BaseModel):
    #: The hospital system's ID (e.g. "Appointment/123"); the platform stores only its hash.
    external_id: str
    at: datetime
    mrn: str
    name: str | None
    ncid: str | None
    practitioner: str | None


@app.get("/v1/appointments", response_model=list[AppointmentRow])
def appointments(
    days: int = Query(7, ge=1, le=60), s: Staff = Depends(desk), db: DbSession = Depends(get_db)
) -> list[AppointmentRow]:
    """Booked appointments from now (minus a day) to `days` ahead, with names, read live."""
    from datetime import UTC, timedelta

    now_ = datetime.now(UTC)
    try:
        found = records().appointments(now_ - timedelta(days=1), now_ + timedelta(days=days))
    except RecordsUnavailableError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, {"code": "records_unavailable"}) from exc
    except AttributeError as exc:  # an adapter without appointments
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, {"code": "no_appointments_source"}) from exc
    links = {
        m.mrn: m.ncid for m in db.scalars(select(NcidMap).where(NcidMap.mrn.in_([a.mrn for a in found])))
    }
    names: dict[str, str | None] = {}
    for a in found:
        if a.mrn not in names:
            try:
                rec = records().get(a.mrn)
            except RecordsUnavailableError:
                rec = None
            names[a.mrn] = rec.name if rec else None
    activity.write(db, s.role, s.user_id, "appointments_listed", results=len(found))
    return [
        AppointmentRow(
            external_id=a.external_id,
            at=a.at,
            mrn=a.mrn,
            name=names.get(a.mrn),
            ncid=links.get(a.mrn),
            practitioner=a.practitioner,
        )
        for a in found
    ]


# --- Reviews (M14): kept at the hospital ---


class ReviewIn(BaseModel):
    usable: bool
    note: str | None = Field(default=None, max_length=2000)


class ReviewOut(BaseModel):
    id: str
    take_id: str
    ncid: str
    usable: bool
    note: str | None
    reviewer_id: str
    at: datetime


def _review_out(r: Review) -> ReviewOut:
    return ReviewOut(
        id=r.id,
        take_id=r.take_id,
        ncid=r.ncid,
        usable=r.usable,
        note=r.note,
        reviewer_id=r.reviewer_id,
        at=r.at,
    )


@app.post("/v1/takes/{take_id}/review", response_model=ReviewOut, status_code=201)
def review_take(
    take_id: str, body: ReviewIn, s: Staff = Depends(doctor), db: DbSession = Depends(get_db)
) -> ReviewOut:
    """A doctor marks a recording usable or not usable. The note stays in the hospital's database."""
    try:
        info = platform.call("GET", f"/connector/v1/takes/{take_id}")
    except platform.PlatformError as exc:
        raise _platform_error(exc) from exc
    if db.get(NcidMap, info["ncid"]) is None or info["ncid"] not in allowed(s, [info["ncid"]]):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "take not found")
    r = Review(
        take_id=take_id,
        ncid=info["ncid"],
        usable=body.usable,
        note=(body.note or "").strip() or None,
        reviewer_id=s.user_id,
    )
    db.add(r)
    db.commit()
    activity.write(db, s.role, s.user_id, "take_reviewed", info["ncid"], take_id=take_id, usable=body.usable)
    return _review_out(r)


@app.get("/v1/patients/{ncid}/reviews", response_model=list[ReviewOut])
def reviews(ncid: str, s: Staff = Depends(clinical), db: DbSession = Depends(get_db)) -> list[ReviewOut]:
    _mrn_for(db, ncid)
    require_access(s, ncid)
    q = select(Review).where(Review.ncid == ncid).order_by(Review.at.desc())
    return [_review_out(r) for r in db.scalars(q)]


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
