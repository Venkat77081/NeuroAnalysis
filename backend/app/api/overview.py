"""v10 Overview pages (decision 042): counts and one timeline chart for each dashboard role.

Counts only. The platform admin sees numbers across hospitals and hospital names, never a patient.
Hospital roles see numbers for their own hospital; lists show NCIDs, and the dashboard asks the
hospital's connector for names, as on every other page.
"""

from datetime import UTC, date, datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session as DbSession

from app.assignments import doctor_patients_clause
from app.db import get_db
from app.models import (
    Appointment,
    Device,
    Operator,
    Patient,
    PatientAccount,
    RecordingRequest,
    Session,
    Site,
    SiteKey,
    StaffUser,
    Take,
)
from app.policy import policy
from app.security import Principal, require_role
from app.storage.sites import can_record

router = APIRouter(prefix="/overview", tags=["overview"])
anyone = require_role("platform_admin", "hospital_admin", "receptionist", "doctor")

Period = Literal["4w", "12w", "1y"]


class Tile(BaseModel):
    """One card. `key` names the i18n text; `detail` fills the line under the number."""

    key: str
    value: int | float | None
    detail: dict[str, int | float | str | None] = {}
    #: ok | warn | bad | todo — drawn as a badge with words, never colour alone.
    tone: str | None = None
    #: The dashboard page behind the card.
    link: str | None = None


class Point(BaseModel):
    start: date
    count: int


class Item(BaseModel):
    """A row in the list beside the chart (hospital, appointment or recording)."""

    key: str
    status: str
    id: str | None = None
    name: str | None = None
    ncid: str | None = None
    at: datetime | None = None
    doctor: str | None = None
    place: str | None = None
    flagged: bool | None = None


class OverviewOut(BaseModel):
    role: str
    tiles: list[Tile]
    #: week = counts per week going back; day = counts per day going forward (front desk).
    unit: Literal["week", "day"]
    chart: str
    series: list[Point]
    items: list[Item]


def _cfg() -> dict:
    return policy()["overview"]


def _now() -> datetime:
    return datetime.now(UTC)


def _weeks(rows: list[datetime], days: int) -> list[Point]:
    """Counts per week (Monday starts), oldest first, over the last `days` days."""
    today = _now().date()
    first = today - timedelta(days=days - 1)
    first -= timedelta(days=first.weekday())
    starts = []
    d = first
    while d <= today:
        starts.append(d)
        d += timedelta(days=7)
    counts = dict.fromkeys(starts, 0)
    for t in rows:
        day = t.date()
        if day < first:
            continue
        counts[day - timedelta(days=day.weekday())] = counts.get(day - timedelta(days=day.weekday()), 0) + 1
    return [Point(start=s, count=counts[s]) for s in starts]


def _since(days: int) -> datetime:
    return _now() - timedelta(days=days)


def _count(db: DbSession, stmt) -> int:
    return db.scalar(select(func.count()).select_from(stmt.subquery())) or 0


def _borderline(db: DbSession, *where) -> int:
    warn = policy()["deviceCheck"]["warnBelowFps"]
    return _count(
        db,
        select(Device.id).where(
            Device.kind == "clinic", Device.revoked_at.is_(None), Device.check_fps < warn, *where
        ),
    )


def _uploaded(db: DbSession, days: int, *where) -> list[datetime]:
    """Upload times of complete takes (one take = one video)."""
    return list(
        db.scalars(
            select(Take.uploaded_at)
            .join(Session, Session.id == Take.session_id)
            .join(Patient, Patient.id == Session.patient_id)
            .where(Take.status == "complete", Take.uploaded_at >= _since(days), *where)
        )
    )


def _patients(db: DbSession, *where) -> tuple[int, int]:
    """(all NCIDs, those with the app)."""
    total = _count(db, select(Patient.id).where(*where))
    in_app = _count(
        db,
        select(PatientAccount.id)
        .join(Patient, Patient.id == PatientAccount.patient_id)
        .where(PatientAccount.status.in_(("active", "locked")), *where),
    )
    return total, in_app


def _locked_or_off(db: DbSession, *where) -> int:
    max_failed = policy()["operators"]["maxFailedLogins"]
    return _count(
        db,
        select(Operator.id).where(
            (Operator.active.is_(False)) | (Operator.failed_logins >= max_failed), *where
        ),
    )


# ---------------------------------------------------------------- platform admin


def _site_issue(db: DbSession, site: Site) -> str:
    if site.status == "suspended":
        return "suspended"
    admin_ready = db.scalar(
        select(func.count())
        .select_from(StaffUser)
        .where(
            StaffUser.site_id == site.id,
            StaffUser.role == "hospital_admin",
            StaffUser.password_hash.is_not(None),
        )
    )
    if not admin_ready:
        return "admin_not_signed_up"
    if not site.connector_check:
        return "connector_not_tested"
    if any(v != "pass" for v in site.connector_check.values()):
        return "connector_failing"
    if site.storage_kind == "none":
        return "storage_not_connected"
    if not can_record(site):
        return "storage_failing" if site.storage_check else "storage_not_tested"
    return "ok"


def _platform(db: DbSession, days: int) -> OverviewOut:
    c = _cfg()
    sites = list(db.scalars(select(Site).order_by(Site.name)))
    onboarded = [s for s in sites if s.status != "suspended"]
    recent = _since(c["recentDays"])
    total, in_app = _patients(db)
    issues = [(s, _site_issue(db, s)) for s in sites]
    order = {"ok": 2, "suspended": 1}
    issues.sort(key=lambda x: (order.get(x[1], 0), x[0].name.lower()))
    phones = _count(db, select(Device.id).where(Device.kind == "clinic", Device.revoked_at.is_(None)))
    borderline = _borderline(db)
    tiles = [
        Tile(
            key="hospitals",
            value=len(onboarded),
            detail={
                "active": sum(s.status == "active" for s in sites),
                "settingUp": sum(s.status == "invited" for s in sites),
                "recent": sum(1 for s in onboarded if s.onboarded_at and s.onboarded_at >= recent),
                "days": c["recentDays"],
            },
            link="hospitals",
        ),
        Tile(key="hospitalsLeft", value=len(sites) - len(onboarded), link="hospitals"),
        Tile(key="patients", value=total, detail={"inApp": in_app, "clinicOnly": total - in_app}),
        Tile(
            key="phones",
            value=phones,
            detail={"borderline": borderline},
            tone="warn" if borderline else None,
        ),
        Tile(
            key="operators",
            value=_count(db, select(Operator.id).where(Operator.active.is_(True))),
            detail={"lockedOrOff": _locked_or_off(db)},
        ),
    ]
    return OverviewOut(
        role="platform_admin",
        tiles=tiles,
        unit="week",
        chart="uploadsAll",
        series=_weeks(_uploaded(db, days), days),
        items=[Item(key="hospital", id=s.id, name=s.name, status=i) for s, i in issues],
    )


# ---------------------------------------------------------------- hospital admin


def _hospital(db: DbSession, site: Site, days: int) -> OverviewOut:
    c = _cfg()
    here = Patient.site_id == site.id
    total, in_app = _patients(db, here)
    recent = _uploaded(db, c["recentDays"], here)
    retakes = _count(
        db,
        select(Take.id)
        .join(Session, Session.id == Take.session_id)
        .join(Patient, Patient.id == Session.patient_id)
        .where(
            Take.status == "complete", Take.uploaded_at >= _since(c["recentDays"]), Take.take_no > 1, here
        ),
    )
    phones = list(
        db.scalars(
            select(Device).where(
                Device.site_id == site.id, Device.kind == "clinic", Device.revoked_at.is_(None)
            )
        )
    )
    used = set(
        db.scalars(
            select(Session.device_id).where(
                Session.device_id.in_([d.id for d in phones]), Session.started_at >= _since(c["recentDays"])
            )
        )
    )
    borderline = _borderline(db, Device.site_id == site.id)
    unused = sum(1 for d in phones if d.id not in used and d.registered_at < _since(c["recentDays"]))
    ops = Operator.site_id == site.id
    staff = list(
        db.scalars(
            select(StaffUser).where(
                StaffUser.site_id == site.id,
                StaffUser.active.is_(True),
                StaffUser.role.in_(("doctor", "receptionist")),
            )
        )
    )
    key = db.scalar(select(SiteKey).where(SiteKey.site_id == site.id, SiteKey.status == "active"))
    conn = site.connector_check or {}
    msg = site.messaging_status or {}
    storage = site.storage_check or {}

    def check(d: dict) -> str:
        return "missing" if not d else ("pass" if all(v == "pass" for v in d.values()) else "fail")

    items = [
        Item(key="connector", status=check(conn), at=site.connector_checked_at),
        Item(key="takeKey", status="active" if key else "missing", at=key.created_at if key else None),
        Item(key="email", status=msg.get("email", "unknown")),
        Item(key="sms", status=msg.get("sms", "unknown")),
        Item(
            key="storage",
            status="pass"
            if can_record(site)
            else ("missing" if site.storage_kind == "none" else check(storage)),
            place=site.storage_kind,
            at=site.storage_checked_at,
        ),
    ]
    tiles = [
        Tile(key="patients", value=total, detail={"inApp": in_app, "clinicOnly": total - in_app}),
        Tile(
            key="recordings",
            value=len(recent),
            detail={
                "days": c["recentDays"],
                "retakenPct": round(100 * retakes / len(recent)) if recent else 0,
            },
        ),
        Tile(
            key="phones",
            value=len(phones),
            detail={"borderline": borderline, "unused": unused, "days": c["recentDays"]},
            tone="warn" if borderline or unused else None,
            link="phones",
        ),
        Tile(
            key="operators",
            value=_count(db, select(Operator.id).where(ops, Operator.active.is_(True))),
            detail={
                "mustChange": _count(
                    db,
                    select(Operator.id).where(ops, Operator.active.is_(True), Operator.must_change_password),
                ),
                "lockedOrOff": _locked_or_off(db, ops),
            },
            link="phones",
        ),
        Tile(
            key="staff",
            value=len(staff),
            detail={
                "doctors": sum(u.role == "doctor" for u in staff),
                "desk": sum(u.role == "receptionist" for u in staff),
                "notSignedUp": sum(u.password_hash is None for u in staff),
            },
            link="team",
        ),
    ]
    return OverviewOut(
        role="hospital_admin",
        tiles=tiles,
        unit="week",
        chart="uploadsHospital",
        series=_weeks(_uploaded(db, days, here), days),
        items=items,
    )


# ---------------------------------------------------------------- front desk


def _zone(tz: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(tz or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def _has_request():
    return select(RecordingRequest.appointment_id).where(
        RecordingRequest.appointment_id.is_not(None), RecordingRequest.status != "cancelled"
    )


def _desk(db: DbSession, site: Site, zone: ZoneInfo) -> OverviewOut:
    c = _cfg()
    local_today = datetime.now(zone).date()
    day0 = datetime.combine(local_today, datetime.min.time(), zone).astimezone(UTC)
    day1 = day0 + timedelta(days=1)
    booked = and_(Appointment.site_id == site.id, Appointment.status == "booked")
    today = list(
        db.scalars(
            select(Appointment)
            .where(booked, Appointment.at >= day0, Appointment.at < day1)
            .order_by(Appointment.at)
        )
    )
    upcoming = and_(booked, Appointment.at >= _now())
    in_app = select(PatientAccount.patient_id).where(PatientAccount.status.in_(("active", "locked")))
    week_end = _now() + timedelta(days=c["inviteDays"])
    queue_today = _count(
        db,
        select(RecordingRequest.id).where(
            RecordingRequest.site_id == site.id,
            RecordingRequest.place == "clinic",
            RecordingRequest.status == "open",
            RecordingRequest.due_at >= day0,
            RecordingRequest.due_at < day1 + timedelta(hours=12),
        ),
    )
    invites = list(
        db.scalars(
            select(PatientAccount.status).where(
                PatientAccount.site_id == site.id, PatientAccount.created_at >= _since(c["inviteDays"])
            )
        )
    )
    tiles = [
        Tile(key="today", value=len(today), detail={"queue": queue_today}, link="appointments"),
        Tile(
            key="needDoctor",
            value=_count(db, select(Appointment.id).where(upcoming, Appointment.doctor_id.is_(None))),
            link="appointments",
        ),
        Tile(
            key="waitingTests",
            value=_count(
                db,
                select(Appointment.id).where(
                    upcoming, Appointment.doctor_id.is_not(None), Appointment.id.not_in(_has_request())
                ),
            ),
            link="appointments",
        ),
        Tile(
            key="notInApp",
            value=_count(
                db,
                select(Appointment.patient_id)
                .where(upcoming, Appointment.at < week_end, Appointment.patient_id.not_in(in_app))
                .distinct(),
            ),
            detail={"days": c["inviteDays"]},
            link="invite",
        ),
        Tile(
            key="invitesSent",
            value=len(invites),
            detail={"notOpened": sum(s == "invited" for s in invites), "days": c["inviteDays"]},
            link="invite",
        ),
    ]
    tiles[1].tone = "todo" if tiles[1].value else None
    end = day0 + timedelta(days=c["deskDays"])
    counts = {local_today + timedelta(days=i): 0 for i in range(c["deskDays"])}
    for at in db.scalars(select(Appointment.at).where(booked, Appointment.at >= day0, Appointment.at < end)):
        d = at.astimezone(zone).date()
        if d in counts:
            counts[d] += 1
    with_req = set(db.scalars(_has_request()))
    recorded = set(
        db.scalars(
            select(RecordingRequest.appointment_id)
            .join(Session, Session.request_id == RecordingRequest.id)
            .join(Take, Take.session_id == Session.id)
            .where(Take.status == "complete")
        )
    )
    places = {
        r.appointment_id: r.place
        for r in db.scalars(
            select(RecordingRequest).where(RecordingRequest.appointment_id.in_([a.id for a in today]))
        )
    }
    joined = set(db.scalars(in_app))
    names = {
        u.id: u.display_name or u.email
        for u in db.scalars(select(StaffUser).where(StaffUser.site_id == site.id))
    }
    pts = {
        p.id: p.ncid for p in db.scalars(select(Patient).where(Patient.id.in_([a.patient_id for a in today])))
    }

    def state(a: Appointment) -> str:
        if a.id in recorded:
            return "recorded"
        if not a.doctor_id:
            return "needDoctor"
        if a.id not in with_req:
            return "waitingTests"
        if places.get(a.id) == "clinic":
            return "clinicQueue"
        return "homeLink" if a.patient_id in joined else "notJoined"

    return OverviewOut(
        role="receptionist",
        tiles=tiles,
        unit="day",
        chart="appointmentsAhead",
        series=[Point(start=d, count=n) for d, n in counts.items()],
        items=[
            Item(
                key="appointment",
                id=a.id,
                ncid=pts.get(a.patient_id),
                at=a.at,
                doctor=names.get(a.doctor_id) if a.doctor_id else None,
                status=state(a),
            )
            for a in today
        ],
    )


# ---------------------------------------------------------------- doctor


def _doctor(db: DbSession, p: Principal, days: int) -> OverviewOut:
    c = _cfg()
    mine = doctor_patients_clause(p.actor_id)
    upcoming = and_(
        Appointment.doctor_id == p.actor_id, Appointment.status == "booked", Appointment.at >= _now()
    )
    waiting = _count(db, select(Appointment.id).where(upcoming, Appointment.id.not_in(_has_request())))
    soon = _count(
        db,
        select(Appointment.id).where(
            upcoming, Appointment.at < _now() + timedelta(days=c["doctorUpcomingDays"])
        ),
    )
    patients = _count(db, select(Patient.id).where(mine))
    # Home links of my appointments due in the window: recorded (a complete take) by the due date.
    due = list(
        db.scalars(
            select(RecordingRequest)
            .join(Appointment, Appointment.id == RecordingRequest.appointment_id)
            .where(
                Appointment.doctor_id == p.actor_id,
                RecordingRequest.place == "home",
                RecordingRequest.status != "cancelled",
                RecordingRequest.due_at >= _since(c["onTimeDays"]),
                RecordingRequest.due_at < _now(),
            )
        )
    )
    on_time = 0
    for r in due:
        first = db.scalar(
            select(func.min(Take.uploaded_at))
            .join(Session, Session.id == Take.session_id)
            .where(Session.request_id == r.id, Take.status == "complete")
        )
        if first and first <= r.due_at:
            on_time += 1
    recent_rows = list(
        db.execute(
            select(Session, Patient.ncid, func.max(Take.flagged_for_review))
            .join(Patient, Patient.id == Session.patient_id)
            .join(Take, Take.session_id == Session.id)
            .where(mine, Take.status == "complete", Session.started_at >= _since(c["inviteDays"]))
            .group_by(Session.id, Patient.ncid)
            .order_by(Session.started_at.desc())
        )
    )
    tiles = [
        Tile(key="chooseTests", value=waiting, tone="todo" if waiting else None, link="chooseTests"),
        Tile(key="upcoming", value=soon, detail={"days": c["doctorUpcomingDays"]}),
        Tile(
            key="newRecordings", value=len(recent_rows), detail={"days": c["inviteDays"]}, link="myPatients"
        ),
        Tile(key="myPatients", value=patients, link="myPatients"),
        Tile(
            key="onTime",
            value=round(100 * on_time / len(due)) if due else None,
            detail={"days": c["onTimeDays"], "links": len(due)},
        ),
    ]
    return OverviewOut(
        role="doctor",
        tiles=tiles,
        unit="week",
        chart="uploadsMine",
        series=_weeks(_uploaded(db, days, mine), days),
        items=[
            Item(
                key="recording",
                id=s.id,
                ncid=ncid,
                at=s.started_at,
                place="home" if s.recorded_by == "patient" else "clinic",
                flagged=bool(flag),
                status="new",
            )
            for s, ncid, flag in recent_rows[:8]
        ],
    )


@router.get("", response_model=OverviewOut)
def overview(
    period: Period = "12w",
    tz: str | None = Query(default=None, max_length=64),
    p: Principal = Depends(anyone),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> OverviewOut:
    days = _cfg()["periodsDays"][period]
    if p.role == "platform_admin":
        return _platform(db, days)
    site = db.get(Site, p.site_id)
    if p.role == "hospital_admin":
        return _hospital(db, site, days)
    if p.role == "receptionist":
        return _desk(db, site, _zone(tz))
    return _doctor(db, p, days)
