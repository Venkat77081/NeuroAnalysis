"""Appointment changes (v13 decision 045, v14 decision 046): hospital settings, doctors' clinic
hours, free times, moving and cancelling an appointment, and the notices the hospital connector
sends. Patients' requests, bookings and the desk's offers are in `appointment_requests`.

- Free times: the doctors' clinic hours minus their booked appointments and the times held for a
  patient by an open offer, in the hospital's time zone.
- A move takes the appointment's recordings with it (decision 046):
  - recorded at home within `recording_valid_days` of the new date: kept;
  - recorded earlier than that: a new record link, same tests (or, with another doctor, theirs);
  - not recorded, same doctor: the record-by date moves to `record_due_days_before` the new date;
  - not recorded, another doctor: the link is withdrawn and the new doctor confirms the tests
    (`Appointment.suggested_tests` pre-fills their choice).
- Cancelling (desk or patient, any time) needs a reason code; recordings already made stay.
"""

import logging
import re
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from app.api.connector_link import signed_connector
from app.api.requests import (
    AppointmentOut,
    _appointment,
    _appt_out,
    _doctor_name,
    _doctor_ok,
    aware,
    request_state,
)
from app.audit import audit
from app.db import get_db
from app.delivery import DeliveryError
from app.hospital_settings import OPTIONS, site_settings, site_tz, valid_time_zone
from app.models import (
    Appointment,
    AppointmentChangeRequest,
    AppointmentNotice,
    AppointmentOffer,
    DoctorHours,
    Patient,
    RecordingRequest,
    Session,
    Site,
    StaffUser,
    Take,
)
from app.permissions import allows, require
from app.policy import policy
from app.providers import doctor_no_show
from app.security import Principal

router = APIRouter(tags=["appointment changes"])
log = logging.getLogger("neurocapture.appointments")
#: v18: the cancel reason when the desk marks that the patient did not come.
NO_SHOW = "no_show"
can_change = require("appointments.add", "appointments.assign")
can_view = require("appointments.view", "appointments.add", "appointments.assign")
any_staff = require(
    "appointments.view", "appointments.add", "appointments.assign", "setup.team", "setup.settings"
)
can_settings = require("setup.settings")
can_team = require("setup.team")

DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
HHMM = r"^([01][0-9]|2[0-3]):[0-5][0-9]$"


def cfg() -> dict:
    return policy()["appointmentChanges"]


def site_of(db: DbSession, site_id: str | None) -> Site:
    site = db.get(Site, site_id) if site_id else None
    if not site:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "hospital not found")
    return site


def utc(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


# --- Hospital settings ---


class SettingsOut(BaseModel):
    device_min_fps: float
    change_cutoff_hours: int
    patient_changes: bool
    time_zone: str
    patient_booking: bool
    booking_preferred: int
    booking_alternatives: int
    times_per_date: int
    booking_days_ahead: int
    booking_min_days: int
    offer_max: int
    offer_reply_hours: int
    recording_valid_days: int
    record_due_days_before: int
    clinic_phone_consent: bool
    #: The choices the dashboard offers (config/platform.json).
    device_min_fps_options: list[float]
    change_cutoff_hour_options: list[int]
    options: dict[str, list[int]]
    warn_below_fps: float


class SettingsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_min_fps: float | None = None
    change_cutoff_hours: int | None = None
    patient_changes: bool | None = None
    time_zone: str | None = Field(default=None, max_length=64)
    patient_booking: bool | None = None
    booking_preferred: int | None = None
    booking_alternatives: int | None = None
    times_per_date: int | None = None
    booking_days_ahead: int | None = None
    booking_min_days: int | None = None
    offer_max: int | None = None
    offer_reply_hours: int | None = None
    recording_valid_days: int | None = None
    record_due_days_before: int | None = None
    clinic_phone_consent: bool | None = None


def _settings_out(site: Site) -> SettingsOut:
    s = site_settings(site)
    pol = policy()
    return SettingsOut(
        **s,
        device_min_fps_options=[float(x) for x in pol["deviceCheck"]["minFpsOptions"]],
        change_cutoff_hour_options=list(cfg()["cutoffHourOptions"]),
        options={k: list(cfg()[v]) for k, v in OPTIONS.items()},
        warn_below_fps=float(pol["deviceCheck"]["warnBelowFps"]),
    )


@router.get("/hospital/settings", response_model=SettingsOut)
def get_settings_(p: Principal = Depends(any_staff), db: DbSession = Depends(get_db)) -> SettingsOut:  # noqa: B008
    return _settings_out(site_of(db, p.site_id))


@router.put("/hospital/settings", response_model=SettingsOut)
def put_settings(
    body: SettingsIn,
    p: Principal = Depends(can_settings),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> SettingsOut:
    site = site_of(db, p.site_id)
    pol = policy()
    given = body.model_dump(exclude_none=True)
    if "device_min_fps" in given and given["device_min_fps"] not in pol["deviceCheck"]["minFpsOptions"]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "fps_not_offered"})
    if "change_cutoff_hours" in given and given["change_cutoff_hours"] not in cfg()["cutoffHourOptions"]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "cutoff_not_offered"})
    for k, opts in OPTIONS.items():
        if k in given and given[k] not in cfg()[opts]:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "setting_not_offered", "setting": k}
            )
    if "time_zone" in given and not valid_time_zone(given["time_zone"]):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "time_zone_unknown"})
    current = site_settings(site)
    changed = {k: v for k, v in given.items() if current.get(k) != v}
    site.settings = {**(site.settings or {}), **changed}
    if changed:
        audit(db, p.actor_type, p.actor_id, "settings_changed", "site", site.id, site_id=site.id, **changed)
    db.commit()
    return _settings_out(site)


# --- Doctors' clinic hours ---


class LeaveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    from_: date = Field(alias="from")
    to: date


class HoursIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    department: str | None = Field(default=None, max_length=80)
    #: {"mon": [["09:00", "13:00"]], ...}: the hospital's local time.
    week: dict[Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"], list[list[str]]] = Field(
        default_factory=dict
    )
    slot_minutes: int | None = None
    leave: list[LeaveIn] = Field(default_factory=list, max_length=50)
    #: v14: offered to patients booking in the app.
    bookable: bool = True


class HoursOut(BaseModel):
    doctor_id: str
    doctor_name: str
    department: str | None
    week: dict[str, list[list[str]]]
    slot_minutes: int
    leave: list[dict]
    #: False: no hours set yet (the desk can still type a time).
    has_hours: bool
    bookable: bool


def _check_week(week: dict) -> dict:
    out = {}
    for day, spans in week.items():
        clean = []
        for span in spans:
            if len(span) != 2 or not all(re.match(HHMM, x) for x in span) or span[0] >= span[1]:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "hours_invalid"})
            clean.append([span[0], span[1]])
        clean.sort()
        for a, b in zip(clean, clean[1:], strict=False):
            if b[0] < a[1]:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "hours_overlap"})
        if clean:
            out[day] = clean
    return out


def _hours_out(d: StaffUser, h: DoctorHours | None) -> HoursOut:
    return HoursOut(
        doctor_id=d.id,
        doctor_name=d.display_name or d.email,
        department=h.department if h else None,
        week=dict(h.week or {}) if h else {},
        slot_minutes=h.slot_minutes if h else int(cfg()["slotMinutes"]),
        leave=list(h.leave or []) if h else [],
        has_hours=bool(h and h.week),
        bookable=h.bookable if h else True,
    )


def doctors_of(db: DbSession, site_id: str) -> list[StaffUser]:
    return list(
        db.scalars(
            select(StaffUser)
            .where(StaffUser.site_id == site_id, StaffUser.role == "doctor", StaffUser.active.is_(True))
            .order_by(StaffUser.display_name)
        )
    )


@router.get("/hospital/doctor-hours", response_model=list[HoursOut])
def list_hours(p: Principal = Depends(any_staff), db: DbSession = Depends(get_db)) -> list[HoursOut]:  # noqa: B008
    return [_hours_out(d, db.get(DoctorHours, d.id)) for d in doctors_of(db, p.site_id)]


@router.put("/hospital/doctor-hours/{doctor_id}", response_model=HoursOut)
def put_hours(
    doctor_id: str,
    body: HoursIn,
    p: Principal = Depends(can_team),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> HoursOut:
    d = db.get(StaffUser, doctor_id)
    if not d or d.site_id != p.site_id or d.role != "doctor":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "doctor not found")
    slot = body.slot_minutes or int(cfg()["slotMinutes"])
    if slot not in cfg()["slotMinuteOptions"]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "slot_not_offered"})
    if any(lv.to < lv.from_ for lv in body.leave):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "leave_invalid"})
    h = db.get(DoctorHours, d.id) or DoctorHours(doctor_id=d.id, site_id=p.site_id)
    h.department = (body.department or "").strip() or None
    h.week = _check_week(body.week)
    h.slot_minutes = slot
    h.leave = [{"from": lv.from_.isoformat(), "to": lv.to.isoformat()} for lv in body.leave]
    h.bookable = body.bookable
    h.updated_by, h.updated_at = p.actor_id, datetime.now(UTC)
    db.add(h)
    audit(db, p.actor_type, p.actor_id, "doctor_hours_changed", "staff", d.id, site_id=p.site_id, doctor=d.id)
    db.commit()
    return _hours_out(d, h)


# --- Free times ---


class DoctorDay(BaseModel):
    doctor_id: str
    doctor_name: str
    department: str | None
    has_hours: bool
    on_leave: bool
    bookable: bool
    #: Clinic hours that day, e.g. [["09:00", "13:00"]].
    hours: list[list[str]]
    #: Free start times ("09:45"), the hospital's local time.
    free: list[str]
    #: Times held for a patient by an open offer (not free for anyone else).
    held: list[str]
    #: Booked appointments that day (not counting the one being moved).
    booked: int


class AvailabilityOut(BaseModel):
    date: date
    time_zone: str
    doctors: list[DoctorDay]


def _on_leave(h: DoctorHours | None, day: date) -> bool:
    iso = day.isoformat()
    return bool(h) and any(lv["from"] <= iso <= lv["to"] for lv in (h.leave or []))


def held_times(
    db: DbSession, site_id: str, now_: datetime, exclude_offer: str | None = None
) -> list[tuple[str, datetime]]:
    """(doctor_id, at) held for patients by open offers that have not run out."""
    out = []
    for o in db.scalars(
        select(AppointmentOffer).where(
            AppointmentOffer.site_id == site_id,
            AppointmentOffer.status.in_(("open", "call_requested")),
            AppointmentOffer.reply_by > now_,
        )
    ):
        if o.id != exclude_offer:
            out += [(x["doctor_id"], datetime.fromisoformat(x["at"])) for x in o.options]
    return out


def doctor_day(
    db: DbSession,
    site: Site,
    d: StaffUser,
    day: date,
    exclude: str | None,
    now_: datetime,
    *,
    held: list[tuple[str, datetime]] | None = None,
    not_before: datetime | None = None,
) -> DoctorDay:
    tz = site_tz(site)
    h = db.get(DoctorHours, d.id)
    start = datetime.combine(day, time(0), tzinfo=tz)
    end_day = start + timedelta(days=1)
    booked = [
        aware(a.at)
        for a in db.scalars(
            select(Appointment).where(
                Appointment.doctor_id == d.id,
                Appointment.status == "booked",
                Appointment.at >= start.astimezone(UTC),
                Appointment.at < end_day.astimezone(UTC),
            )
        )
        if a.id != exclude
    ]
    held_here = [
        utc(at)
        for doc, at in (held if held is not None else held_times(db, site.id, now_))
        if doc == d.id and start <= utc(at) < end_day
    ]
    spans = list((h.week or {}).get(DAYS[day.weekday()], [])) if h else []
    leave = _on_leave(h, day)
    slot = timedelta(minutes=h.slot_minutes if h else int(cfg()["slotMinutes"]))
    earliest = max(now_, not_before or now_)
    free: list[str] = []
    if not leave:
        for a, b in spans:
            s = datetime.combine(day, time.fromisoformat(a), tzinfo=tz)
            end = datetime.combine(day, time.fromisoformat(b), tzinfo=tz)
            while s + slot <= end:
                taken = any(abs(x - s) < slot for x in booked + held_here)
                if s > earliest and not taken:
                    free.append(s.strftime("%H:%M"))
                s += slot
    return DoctorDay(
        doctor_id=d.id,
        doctor_name=d.display_name or d.email,
        department=h.department if h else None,
        has_hours=bool(spans) or bool(h and h.week),
        on_leave=leave,
        bookable=h.bookable if h else True,
        hours=spans,
        free=free,
        held=sorted(x.astimezone(tz).strftime("%H:%M") for x in held_here),
        booked=len(booked),
    )


def time_state(db: DbSession, site: Site, doctor_id: str | None, at: datetime, exclude: str | None) -> str:
    """free | taken | leave | off (outside clinic hours or no hours) | past, for one time now."""
    now_ = datetime.now(UTC)
    at = utc(at)
    if at <= now_:
        return "past"
    tz = site_tz(site)
    local = at.astimezone(tz)
    docs = [db.get(StaffUser, doctor_id)] if doctor_id else doctors_of(db, site.id)
    states = []
    for d in docs:
        if not d or not d.active:
            continue
        dd = doctor_day(db, site, d, local.date(), exclude, now_)
        hhmm = local.strftime("%H:%M")
        if hhmm in dd.free:
            return "free"
        if dd.on_leave:
            states.append("leave")
        elif not any(a <= hhmm < b for a, b in dd.hours):
            states.append("off")
        else:
            states.append("taken")
    return "taken" if "taken" in states else (states[0] if states else "off")


@router.get("/hospital/availability", response_model=AvailabilityOut)
def availability(
    day: date = Query(alias="date"),
    appointment_id: str | None = Query(default=None, max_length=32),
    p: Principal = Depends(can_change),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> AvailabilityOut:
    """Each doctor's free times on `date`. The appointment's own doctor first, then the same
    department, then the rest."""
    site = site_of(db, p.site_id)
    current = _appointment(db, p, appointment_id)[0] if appointment_id else None
    now_ = datetime.now(UTC)
    held = held_times(db, site.id, now_)
    rows = [doctor_day(db, site, d, day, appointment_id, now_, held=held) for d in doctors_of(db, site.id)]
    own = next((r for r in rows if current and r.doctor_id == current.doctor_id), None)
    dept = own.department if own else None

    def rank(r: DoctorDay) -> tuple:
        return (r is not own, not (dept and r.department == dept), r.doctor_name.lower())

    return AvailabilityOut(
        date=day, time_zone=site_settings(site)["time_zone"], doctors=sorted(rows, key=rank)
    )


# --- Notices (the connector tells the patient by SMS / e-mail) ---


def notice(
    db: DbSession, site_id: str, patient_id: str, kind: str, *, appointment_id=None, offer_id=None
) -> None:
    db.add(
        AppointmentNotice(
            site_id=site_id,
            patient_id=patient_id,
            appointment_id=appointment_id,
            offer_id=offer_id,
            kind=kind,
        )
    )


# --- Moving: recordings follow the appointment (decision 046) ---


def _recorded_at(db: DbSession, r: RecordingRequest) -> datetime | None:
    at = db.scalar(
        select(func.max(Session.started_at))
        .join(Take, Take.session_id == Session.id)
        .where(Session.request_id == r.id, Take.status == "complete")
    )
    return aware(at) if at else None


def move_recordings(
    db: DbSession, a: Appointment, new_at: datetime, doctor_changed: bool, old_doctor: str | None
) -> None:
    s = site_settings(db.get(Site, a.site_id))
    valid = timedelta(days=int(s["recording_valid_days"]))
    due_before = timedelta(days=int(s["record_due_days_before"]))
    suggested: dict | None = None
    for r in list(db.scalars(select(RecordingRequest).where(RecordingRequest.appointment_id == a.id))):
        state = request_state(db, r)
        if state in ("cancelled", "not_recorded"):
            continue
        if state == "recorded":
            if r.place != "home":
                continue
            rec = _recorded_at(db, r)
            if rec is None or new_at - rec <= valid:
                continue  # it counts for the new date
            if doctor_changed:
                suggested = {"tests": list(r.tests), "med_state": r.med_state, "places": ["home"]}
                continue
            db.add(
                RecordingRequest(
                    site_id=r.site_id,
                    patient_id=r.patient_id,
                    appointment_id=a.id,
                    kind="appointment",
                    tests=list(r.tests),
                    med_state=r.med_state,
                    due_at=new_at - due_before,
                    remind=True,
                    place="home",
                    created_by=r.created_by,
                )
            )
            continue
        # Not recorded yet.
        if doctor_changed:
            r.status = "cancelled"
            places = sorted({*(suggested or {}).get("places", []), r.place})
            suggested = {"tests": list(r.tests), "med_state": r.med_state, "places": places}
            continue
        r.due_at = new_at - due_before if r.place == "home" else new_at + timedelta(hours=12)
        r.reminder_sent_at = None
    if suggested:
        a.suggested_tests = {**suggested, "from_doctor": old_doctor}


def apply_move(
    db: DbSession,
    p: Principal,
    a: Appointment,
    new_at: datetime,
    new_doctor: str | None,
    reason: str,
    *,
    accepted: AppointmentChangeRequest | None = None,
) -> None:
    """Moves the appointment and what hangs off it: its recordings (decision 046), an open patient
    request (accepted, or closed) and open offers (closed). Logged as appointment_moved (and
    appointment_doctor_changed)."""
    old_at, old_doctor = aware(a.at), a.doctor_id
    new_at = utc(new_at)
    doctor_changed = bool(new_doctor) and new_doctor != old_doctor
    if doctor_changed:
        if p.kind == "staff":
            _doctor_ok(db, p, new_doctor)
        audit(
            db,
            p.actor_type,
            p.actor_id,
            "appointment_doctor_changed",
            "appointment",
            a.id,
            site_id=a.site_id,
            at=new_at.isoformat(),
            doctor=new_doctor,
            previous=old_doctor,
        )
        a.doctor_id = new_doctor
    move_recordings(db, a, new_at, doctor_changed, old_doctor)
    a.at = new_at
    a.moved_at, a.moved_from, a.moved_reason = datetime.now(UTC), old_at, reason
    a.moved_from_doctor_id = old_doctor if doctor_changed else None
    for cr in db.scalars(
        select(AppointmentChangeRequest).where(
            AppointmentChangeRequest.appointment_id == a.id,
            AppointmentChangeRequest.status.in_(("open", "offered")),
        )
    ):
        cr.status = "accepted" if accepted is not None and cr.id == accepted.id else "closed"
        cr.answered_by, cr.answered_at = p.actor_id, datetime.now(UTC)
    close_offers(db, a.id, keep=None)
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "appointment_moved",
        "appointment",
        a.id,
        site_id=a.site_id,
        **{"from": old_at.isoformat(), "at": new_at.isoformat(), "reason": reason},
        doctor=a.doctor_id,
    )


def close_offers(db: DbSession, appointment_id: str, keep: str | None) -> None:
    for o in db.scalars(
        select(AppointmentOffer).where(
            AppointmentOffer.appointment_id == appointment_id,
            AppointmentOffer.status.in_(("open", "call_requested")),
        )
    ):
        if o.id != keep:
            o.status, o.answered_at = "closed", datetime.now(UTC)


class MoveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    at: datetime
    #: Omitted: the same doctor.
    doctor_id: str | None = None
    reason: str = Field(max_length=24)
    #: Also tell the patient by SMS/e-mail through the hospital connector.
    notify: bool = True
    #: The patient's request this answers (accepted).
    change_request_id: str | None = Field(default=None, max_length=32)


def check_move(db: DbSession, p: Principal, a: Appointment, doctor_id: str | None) -> None:
    if not allows(db, p, "appointments.add"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "not_permitted"})
    if doctor_id and doctor_id != a.doctor_id and not allows(db, p, "appointments.assign"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "not_permitted"})
    if a.status == "cancelled":
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "appointment_cancelled"})


def future(at: datetime) -> datetime:
    at = utc(at)
    if at <= datetime.now(UTC):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "time_in_past"})
    return at


@router.post("/hospital/appointments/{appt_id}/move", response_model=AppointmentOut)
def move_appointment(
    appt_id: str,
    body: MoveIn,
    p: Principal = Depends(can_change),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> AppointmentOut:
    a, pt = _appointment(db, p, appt_id)
    check_move(db, p, a, body.doctor_id)
    if body.reason not in cfg()["deskReasons"]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "reason_unknown"})
    at = future(body.at)
    accepted = None
    if body.change_request_id:
        accepted = db.get(AppointmentChangeRequest, body.change_request_id)
        if not accepted or accepted.appointment_id != a.id or accepted.status not in ("open", "offered"):
            raise HTTPException(status.HTTP_409_CONFLICT, {"code": "request_not_open"})
    apply_move(db, p, a, at, body.doctor_id, body.reason, accepted=accepted)
    if body.notify:
        notice(db, a.site_id, a.patient_id, "moved", appointment_id=a.id)
    db.commit()
    return _appt_out(db, a, pt.ncid)


# --- Cancelling (desk or patient, any time, with a reason) ---


def cancel_appointment(
    db: DbSession, a: Appointment, actor_type: str, actor_id: str, by: str, reason: str
) -> None:
    """Cancels it, with its record links not yet recorded, open patient requests and offers.
    Recordings already made stay with the hospital."""
    a.status = "cancelled"
    a.cancelled_by, a.cancel_reason, a.cancelled_at = by, reason, datetime.now(UTC)
    a.suggested_tests = None
    for r in db.scalars(select(RecordingRequest).where(RecordingRequest.appointment_id == a.id)):
        if request_state(db, r) != "recorded":
            r.status = "cancelled"
    for c in db.scalars(
        select(AppointmentChangeRequest).where(
            AppointmentChangeRequest.appointment_id == a.id,
            AppointmentChangeRequest.status.in_(("open", "offered")),
        )
    ):
        c.status, c.answered_by, c.answered_at = "closed", actor_id, datetime.now(UTC)
    close_offers(db, a.id, keep=None)
    audit(
        db,
        actor_type,
        actor_id,
        "appointment_cancelled",
        "appointment",
        a.id,
        site_id=a.site_id,
        by=by,
        reason=reason,
        at=aware(a.at).isoformat(),
    )


class CancelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str = Field(max_length=24)
    notify: bool = True


@router.post("/hospital/appointments/{appt_id}/cancel", response_model=AppointmentOut)
def desk_cancel(
    appt_id: str,
    body: CancelIn,
    p: Principal = Depends(can_change),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> AppointmentOut:
    a, pt = _appointment(db, p, appt_id)
    if not allows(db, p, "appointments.add"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "not_permitted"})
    if a.status == "cancelled":
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "appointment_cancelled"})
    if body.reason not in cfg()["cancelReasons"]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "reason_unknown"})
    cancel_appointment(db, a, p.actor_type, p.actor_id, "staff", body.reason)
    if body.notify:
        notice(db, a.site_id, a.patient_id, "cancelled", appointment_id=a.id)
    db.commit()
    return _appt_out(db, a, pt.ncid)


class NoShowIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: Tell the patient (SMS / e-mail from the connector, and the app).
    notify: bool = True


@router.post("/hospital/appointments/{appt_id}/no-show", response_model=AppointmentOut)
def desk_no_show(
    appt_id: str,
    body: NoShowIn,
    p: Principal = Depends(can_change),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> AppointmentOut:
    """v18 (decision 049): the patient did not come. From the appointment's time on, the desk marks
    it: the appointment is cancelled (reason `no_show`), the patient is told, and so is the doctor
    (e-mail with the NCID and time only)."""
    a, pt = _appointment(db, p, appt_id)
    if not allows(db, p, "appointments.add"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "not_permitted"})
    if a.status == "cancelled":
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "appointment_cancelled"})
    if datetime.now(UTC) < aware(a.at):
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "not_yet"})
    for r in db.scalars(
        select(RecordingRequest).where(
            RecordingRequest.appointment_id == a.id, RecordingRequest.place == "clinic"
        )
    ):
        if request_state(db, r) == "recorded":
            # The clinic recorded the patient at this visit: they came.
            raise HTTPException(status.HTTP_409_CONFLICT, {"code": "recorded_at_visit"})
    cancel_appointment(db, a, p.actor_type, p.actor_id, "staff", NO_SHOW)
    if body.notify:
        notice(db, a.site_id, a.patient_id, "no_show", appointment_id=a.id)
    doctor = db.get(StaffUser, a.doctor_id) if a.doctor_id else None
    site = db.get(Site, a.site_id)
    db.commit()
    if doctor and doctor.active and doctor.email:
        when = aware(a.at).astimezone(site_tz(site)).strftime("%a %d %b %Y, %H:%M")
        try:
            doctor_no_show(doctor.email, site.name, pt.ncid, when)
        except DeliveryError:
            log.warning("doctor no-show e-mail not sent")
    return _appt_out(db, a, pt.ncid)


@router.post("/hospital/appointments/{appt_id}/cancellation-seen", status_code=204)
def cancellation_seen(
    appt_id: str, p: Principal = Depends(can_view), db: DbSession = Depends(get_db)
) -> None:  # noqa: B008
    a, _ = _appointment(db, p, appt_id)
    a.cancel_seen_at = datetime.now(UTC)
    db.commit()


# --- Notices for the hospital connector (SMS / e-mail) ---


class NoticeOut(BaseModel):
    id: str
    ncid: str
    #: moved | not_changed | offer | cancelled | booked | not_booked | no_show
    kind: str
    at: datetime | None
    #: The same time in the hospital's time zone (ISO with offset), for the message text.
    at_local: str | None
    doctor_name: str | None
    #: offer: answer by (local ISO).
    reply_by_local: str | None = None


@router.get("/connector/v1/appointment-notices/due", response_model=list[NoticeOut])
def notices_due(site: Site = Depends(signed_connector), db: DbSession = Depends(get_db)) -> list[NoticeOut]:  # noqa: B008
    tz = site_tz(site)
    since = datetime.now(UTC) - timedelta(days=7)
    q = (
        select(AppointmentNotice, Patient.ncid)
        .join(Patient, Patient.id == AppointmentNotice.patient_id)
        .where(
            AppointmentNotice.site_id == site.id,
            AppointmentNotice.sent_at.is_(None),
            AppointmentNotice.created_at >= since,
        )
        .order_by(AppointmentNotice.created_at)
    )
    out = []
    for n, ncid in db.execute(q):
        a = db.get(Appointment, n.appointment_id) if n.appointment_id else None
        o = db.get(AppointmentOffer, n.offer_id) if n.offer_id else None
        out.append(
            NoticeOut(
                id=n.id,
                ncid=ncid,
                kind=n.kind,
                at=a.at if a else None,
                at_local=aware(a.at).astimezone(tz).isoformat() if a else None,
                doctor_name=_doctor_name(db, a.doctor_id) if a else None,
                reply_by_local=aware(o.reply_by).astimezone(tz).isoformat() if o else None,
            )
        )
    return out


@router.post("/connector/v1/appointment-notices/{notice_id}/sent", status_code=204)
def notice_sent(
    notice_id: str,
    site: Site = Depends(signed_connector),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> None:
    n = db.get(AppointmentNotice, notice_id)
    if not n or n.site_id != site.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "notice not found")
    n.sent_at = datetime.now(UTC)
    target = ("appointment", n.appointment_id) if n.appointment_id else ("patient", n.patient_id)
    audit(db, "connector", site.id, "appointment_notice_sent", *target, site_id=site.id, kind=n.kind)
    db.commit()
