"""v13 (decision 045): appointment changes.

- The front desk moves an appointment to another date, time or doctor. Free times come from the
  doctors' clinic hours (set by the hospital admin) minus their booked appointments.
- A patient asks for another date for one appointment, from the app: up to 3 days and a part of
  the day, with a reason from a fixed list. Allowed until `change_cutoff_hours` before it.
- The desk accepts (moves it, possibly to another doctor) or declines ("please call us" / "keep the
  booked date"). The patient sees the answer in the app; with "tell the patient", the hospital
  connector also sends it by SMS or e-mail (the platform has no contact details).
- Hospital settings: phones' camera-check pass level, the change cut-off, the time zone.
"""

from datetime import UTC, date, datetime, time, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.api.connector_link import signed_connector
from app.api.requests import AppointmentOut, _appointment, _appt_out, _doctor_name, _doctor_ok, aware
from app.audit import audit
from app.db import get_db
from app.hospital_settings import site_settings, site_tz, valid_time_zone
from app.models import (
    Appointment,
    AppointmentChangeRequest,
    AppointmentNotice,
    DoctorHours,
    Patient,
    RecordingRequest,
    Site,
    StaffUser,
)
from app.permissions import allows, require
from app.policy import policy
from app.security import Principal, current_principal

router = APIRouter(tags=["appointment changes"])
can_change = require("appointments.add", "appointments.assign")
can_view = require("appointments.view", "appointments.add", "appointments.assign")
any_staff = require(
    "appointments.view", "appointments.add", "appointments.assign", "setup.team", "setup.settings"
)
can_settings = require("setup.settings")
can_team = require("setup.team")

DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
HHMM = r"^([01][0-9]|2[0-3]):[0-5][0-9]$"


def _cfg() -> dict:
    return policy()["appointmentChanges"]


def _site(db: DbSession, site_id: str | None) -> Site:
    site = db.get(Site, site_id) if site_id else None
    if not site:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "hospital not found")
    return site


# --- Hospital settings ---


class SettingsOut(BaseModel):
    device_min_fps: float
    change_cutoff_hours: int
    patient_changes: bool
    time_zone: str
    #: The choices the dashboard offers (config/platform.json).
    device_min_fps_options: list[float]
    change_cutoff_hour_options: list[int]
    warn_below_fps: float


class SettingsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_min_fps: float | None = None
    change_cutoff_hours: int | None = None
    patient_changes: bool | None = None
    time_zone: str | None = Field(default=None, max_length=64)


def _settings_out(site: Site) -> SettingsOut:
    s = site_settings(site)
    pol = policy()
    return SettingsOut(
        **s,
        device_min_fps_options=[float(x) for x in pol["deviceCheck"]["minFpsOptions"]],
        change_cutoff_hour_options=list(_cfg()["cutoffHourOptions"]),
        warn_below_fps=float(pol["deviceCheck"]["warnBelowFps"]),
    )


@router.get("/hospital/settings", response_model=SettingsOut)
def get_settings_(p: Principal = Depends(any_staff), db: DbSession = Depends(get_db)) -> SettingsOut:  # noqa: B008
    return _settings_out(_site(db, p.site_id))


@router.put("/hospital/settings", response_model=SettingsOut)
def put_settings(
    body: SettingsIn,
    p: Principal = Depends(can_settings),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> SettingsOut:
    site = _site(db, p.site_id)
    pol = policy()
    if body.device_min_fps is not None and body.device_min_fps not in pol["deviceCheck"]["minFpsOptions"]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "fps_not_offered"})
    if body.change_cutoff_hours is not None and body.change_cutoff_hours not in _cfg()["cutoffHourOptions"]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "cutoff_not_offered"})
    if body.time_zone is not None and not valid_time_zone(body.time_zone):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "time_zone_unknown"})
    new = dict(site.settings or {})
    changed = {k: v for k, v in body.model_dump(exclude_none=True).items() if site_settings(site).get(k) != v}
    new.update(changed)
    site.settings = new
    if changed:
        audit(db, p.actor_type, p.actor_id, "settings_changed", "site", site.id, site_id=site.id, **changed)
    db.commit()
    return _settings_out(site)


# --- Doctors' clinic hours ---


Interval = tuple[str, str]


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


class HoursOut(BaseModel):
    doctor_id: str
    doctor_name: str
    department: str | None
    week: dict[str, list[list[str]]]
    slot_minutes: int
    leave: list[dict]
    #: False: no hours set yet (the desk can still type a time).
    has_hours: bool


def _check_week(week: dict) -> dict:
    import re

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


def _hours_out(db: DbSession, d: StaffUser, h: DoctorHours | None) -> HoursOut:
    return HoursOut(
        doctor_id=d.id,
        doctor_name=d.display_name or d.email,
        department=h.department if h else None,
        week=dict(h.week or {}) if h else {},
        slot_minutes=h.slot_minutes if h else int(_cfg()["slotMinutes"]),
        leave=list(h.leave or []) if h else [],
        has_hours=bool(h and h.week),
    )


def _doctors(db: DbSession, site_id: str) -> list[StaffUser]:
    return list(
        db.scalars(
            select(StaffUser)
            .where(StaffUser.site_id == site_id, StaffUser.role == "doctor", StaffUser.active.is_(True))
            .order_by(StaffUser.display_name)
        )
    )


@router.get("/hospital/doctor-hours", response_model=list[HoursOut])
def list_hours(p: Principal = Depends(any_staff), db: DbSession = Depends(get_db)) -> list[HoursOut]:  # noqa: B008
    return [_hours_out(db, d, db.get(DoctorHours, d.id)) for d in _doctors(db, p.site_id)]


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
    slot = body.slot_minutes or int(_cfg()["slotMinutes"])
    if slot not in _cfg()["slotMinuteOptions"]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "slot_not_offered"})
    if any(lv.to < lv.from_ for lv in body.leave):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "leave_invalid"})
    h = db.get(DoctorHours, d.id) or DoctorHours(doctor_id=d.id, site_id=p.site_id)
    h.department = (body.department or "").strip() or None
    h.week = _check_week(body.week)
    h.slot_minutes = slot
    h.leave = [{"from": lv.from_.isoformat(), "to": lv.to.isoformat()} for lv in body.leave]
    h.updated_by, h.updated_at = p.actor_id, datetime.now(UTC)
    db.add(h)
    audit(db, p.actor_type, p.actor_id, "doctor_hours_changed", "staff", d.id, site_id=p.site_id, doctor=d.id)
    db.commit()
    return _hours_out(db, d, h)


# --- Free times ---


class DoctorDay(BaseModel):
    doctor_id: str
    doctor_name: str
    department: str | None
    has_hours: bool
    on_leave: bool
    #: Clinic hours that day, e.g. [["09:00", "13:00"]].
    hours: list[list[str]]
    #: Free start times ("09:45"), the hospital's local time.
    free: list[str]
    #: Booked appointments that day (not counting the one being moved).
    booked: int


class AvailabilityOut(BaseModel):
    date: date
    time_zone: str
    doctors: list[DoctorDay]


def _on_leave(h: DoctorHours | None, day: date) -> bool:
    iso = day.isoformat()
    return bool(h) and any(lv["from"] <= iso <= lv["to"] for lv in (h.leave or []))


def doctor_day(
    db: DbSession, site: Site, d: StaffUser, day: date, exclude: str | None, now_: datetime
) -> DoctorDay:
    tz = site_tz(site)
    h = db.get(DoctorHours, d.id)
    start = datetime.combine(day, time(0), tzinfo=tz)
    booked = [
        aware(a.at)
        for a in db.scalars(
            select(Appointment).where(
                Appointment.doctor_id == d.id,
                Appointment.status == "booked",
                Appointment.at >= start.astimezone(UTC),
                Appointment.at < (start + timedelta(days=1)).astimezone(UTC),
            )
        )
        if a.id != exclude
    ]
    spans = list((h.week or {}).get(DAYS[day.weekday()], [])) if h else []
    leave = _on_leave(h, day)
    slot = timedelta(minutes=h.slot_minutes if h else int(_cfg()["slotMinutes"]))
    free: list[str] = []
    if not leave:
        for a, b in spans:
            s = datetime.combine(day, time.fromisoformat(a), tzinfo=tz)
            end = datetime.combine(day, time.fromisoformat(b), tzinfo=tz)
            while s + slot <= end:
                if s > now_ and all(abs(x - s) >= slot for x in booked):
                    free.append(s.strftime("%H:%M"))
                s += slot
    return DoctorDay(
        doctor_id=d.id,
        doctor_name=d.display_name or d.email,
        department=h.department if h else None,
        has_hours=bool(spans) or bool(h and h.week),
        on_leave=leave,
        hours=spans,
        free=free,
        booked=len(booked),
    )


@router.get("/hospital/availability", response_model=AvailabilityOut)
def availability(
    day: date = Query(alias="date"),
    appointment_id: str | None = Query(default=None, max_length=32),
    p: Principal = Depends(can_change),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> AvailabilityOut:
    """Each doctor's free times on `date`. The appointment's own doctor first, then the same
    department, then the rest."""
    site = _site(db, p.site_id)
    current = _appointment(db, p, appointment_id)[0] if appointment_id else None
    now_ = datetime.now(UTC)
    rows = [doctor_day(db, site, d, day, appointment_id, now_) for d in _doctors(db, site.id)]
    own = next((r for r in rows if current and r.doctor_id == current.doctor_id), None)
    dept = own.department if own else None

    def rank(r: DoctorDay) -> tuple:
        return (r is not own, not (dept and r.department == dept), r.doctor_name.lower())

    return AvailabilityOut(
        date=day, time_zone=site_settings(site)["time_zone"], doctors=sorted(rows, key=rank)
    )


# --- Moving an appointment ---


def _notice(db: DbSession, a: Appointment, kind: str) -> None:
    db.add(AppointmentNotice(site_id=a.site_id, patient_id=a.patient_id, appointment_id=a.id, kind=kind))


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
    """Moves the appointment and everything that hangs off it: its record links' due dates move by
    the same amount; an open patient request is accepted (or closed when the desk moved it on its
    own). Logged as appointment_moved (and appointment_doctor_changed)."""
    old_at, old_doctor = aware(a.at), a.doctor_id
    new_at = new_at if new_at.tzinfo else new_at.replace(tzinfo=UTC)
    delta = new_at - old_at
    if new_doctor and new_doctor != old_doctor:
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
    if delta:
        for r in db.scalars(select(RecordingRequest).where(RecordingRequest.appointment_id == a.id)):
            if r.status == "open":
                r.due_at = aware(r.due_at) + delta
                r.reminder_sent_at = None
        a.at = new_at
    a.moved_at, a.moved_from, a.moved_reason = datetime.now(UTC), old_at, reason
    a.moved_from_doctor_id = old_doctor if a.doctor_id != old_doctor else None
    for cr in db.scalars(
        select(AppointmentChangeRequest).where(
            AppointmentChangeRequest.appointment_id == a.id, AppointmentChangeRequest.status == "open"
        )
    ):
        cr.status = "accepted" if accepted is not None and cr.id == accepted.id else "closed"
        cr.answered_by, cr.answered_at = p.actor_id, datetime.now(UTC)
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


@router.post("/hospital/appointments/{appt_id}/move", response_model=AppointmentOut)
def move_appointment(
    appt_id: str,
    body: MoveIn,
    p: Principal = Depends(can_change),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> AppointmentOut:
    a, pt = _appointment(db, p, appt_id)
    if not allows(db, p, "appointments.add"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "not_permitted"})
    if body.doctor_id and body.doctor_id != a.doctor_id and not allows(db, p, "appointments.assign"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "not_permitted"})
    if a.status == "cancelled":
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "appointment_cancelled"})
    if body.reason not in _cfg()["deskReasons"]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "reason_unknown"})
    at = body.at if body.at.tzinfo else body.at.replace(tzinfo=UTC)
    if at <= datetime.now(UTC):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "time_in_past"})
    accepted = None
    if body.change_request_id:
        accepted = db.get(AppointmentChangeRequest, body.change_request_id)
        if not accepted or accepted.appointment_id != a.id or accepted.status != "open":
            raise HTTPException(status.HTTP_409_CONFLICT, {"code": "request_not_open"})
    apply_move(db, p, a, at, body.doctor_id, body.reason, accepted=accepted)
    if body.notify:
        _notice(db, a, "moved")
    db.commit()
    return _appt_out(db, a, pt.ncid)


# --- Patients' change requests (desk side) ---


class ChangeOut(BaseModel):
    id: str
    appointment_id: str
    ncid: str
    appointment_at: datetime
    #: manual | fhir (booked in the hospital system: also change it there).
    source: str
    doctor_id: str | None
    doctor_name: str | None
    #: home and/or clinic, from the appointment's record links.
    places: list[str]
    days: list[str]
    part_of_day: str
    reason: str | None
    status: str
    answer: str | None
    created_at: datetime
    answered_at: datetime | None


def _change_out(db: DbSession, c: AppointmentChangeRequest, a: Appointment, ncid: str) -> ChangeOut:
    places = sorted(
        {
            r.place
            for r in db.scalars(select(RecordingRequest).where(RecordingRequest.appointment_id == a.id))
            if r.status != "cancelled"
        }
    )
    return ChangeOut(
        id=c.id,
        appointment_id=a.id,
        ncid=ncid,
        appointment_at=a.at,
        source=a.source,
        doctor_id=a.doctor_id,
        doctor_name=_doctor_name(db, a.doctor_id),
        places=places,
        days=list(c.days),
        part_of_day=c.part_of_day,
        reason=c.reason,
        status=c.status,
        answer=c.answer,
        created_at=c.created_at,
        answered_at=c.answered_at,
    )


@router.get("/hospital/change-requests", response_model=list[ChangeOut])
def list_change_requests(
    p: Principal = Depends(can_view), db: DbSession = Depends(get_db)
) -> list[ChangeOut]:  # noqa: B008
    """Open requests, oldest first. Doctors see those for their own appointments."""
    q = (
        select(AppointmentChangeRequest, Appointment, Patient.ncid)
        .join(Appointment, Appointment.id == AppointmentChangeRequest.appointment_id)
        .join(Patient, Patient.id == AppointmentChangeRequest.patient_id)
        .where(AppointmentChangeRequest.site_id == p.site_id, AppointmentChangeRequest.status == "open")
        .order_by(AppointmentChangeRequest.created_at)
    )
    if p.role == "doctor":
        q = q.where(Appointment.doctor_id == p.actor_id)
    return [_change_out(db, c, a, ncid) for c, a, ncid in db.execute(q)]


class DeclineIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    answer: str = Field(max_length=20)
    notify: bool = True


@router.post("/hospital/change-requests/{req_id}/decline", response_model=ChangeOut)
def decline_change(
    req_id: str,
    body: DeclineIn,
    p: Principal = Depends(can_change),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> ChangeOut:
    c = db.get(AppointmentChangeRequest, req_id)
    if not c or c.site_id != p.site_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "request not found")
    if c.status != "open":
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "request_not_open"})
    if body.answer not in _cfg()["declineAnswers"]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "answer_unknown"})
    a, pt = _appointment(db, p, c.appointment_id)
    c.status, c.answer = "declined", body.answer
    c.answered_by, c.answered_at = p.actor_id, datetime.now(UTC)
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "change_declined",
        "appointment",
        a.id,
        site_id=p.site_id,
        answer=body.answer,
    )
    if body.notify:
        _notice(db, a, "not_changed")
    db.commit()
    return _change_out(db, c, a, pt.ncid)


def close_open_changes(db: DbSession, appointment_id: str, actor_id: str) -> None:
    """The appointment was cancelled: its open requests are closed."""
    for c in db.scalars(
        select(AppointmentChangeRequest).where(
            AppointmentChangeRequest.appointment_id == appointment_id,
            AppointmentChangeRequest.status == "open",
        )
    ):
        c.status, c.answered_by, c.answered_at = "closed", actor_id, datetime.now(UTC)


# --- The patient's app ---


class PatientChange(BaseModel):
    id: str
    days: list[str]
    part_of_day: str
    reason: str | None
    #: open | accepted | declined | withdrawn | closed
    status: str
    answer: str | None
    created_at: datetime
    answered_at: datetime | None


class PatientAppointment(BaseModel):
    id: str
    at: datetime
    doctor_name: str | None
    #: The patient may ask to change it now (on, before the cut-off, nothing open).
    can_ask: bool
    #: Until when they may ask (null: the hospital does not take requests).
    ask_until: datetime | None
    change: PatientChange | None
    #: Set for a recent move: from when, from which doctor, and whether the hospital moved it on its
    #: own (not as an answer to the patient).
    moved_from: datetime | None
    moved_from_doctor_name: str | None
    moved_by_hospital: bool


class PatientAppointmentsOut(BaseModel):
    appointments: list[PatientAppointment]
    time_zone: str
    max_days: int
    max_days_ahead: int
    cutoff_hours: int


def _patient_principal(p: Principal) -> Principal:
    if p.patient is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "patient sign-in required")
    return p


@router.get("/patient/appointments", response_model=PatientAppointmentsOut)
def patient_appointments(
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> PatientAppointmentsOut:
    """The signed-in patient's upcoming appointments at this hospital, with any change request."""
    _patient_principal(p)
    site = db.get(Site, p.patient.site_id)
    s = site_settings(site)
    cfg = _cfg()
    now_ = datetime.now(UTC)
    shown = timedelta(days=int(cfg["answerShownDays"]))
    moved_shown = timedelta(days=int(cfg["movedShownDays"]))
    cutoff = timedelta(hours=int(s["change_cutoff_hours"]))
    out = []
    for a in db.scalars(
        select(Appointment)
        .where(
            Appointment.patient_id == p.patient.patient_id,
            Appointment.status == "booked",
            Appointment.at >= now_,
        )
        .order_by(Appointment.at)
        .limit(20)
    ):
        latest = db.scalar(
            select(AppointmentChangeRequest)
            .where(AppointmentChangeRequest.appointment_id == a.id)
            .order_by(AppointmentChangeRequest.created_at.desc())
            .limit(1)
        )
        if (
            latest
            and latest.status not in ("open",)
            and (
                latest.status == "withdrawn" or now_ - aware(latest.answered_at or latest.created_at) > shown
            )
        ):
            latest = None
        until = aware(a.at) - cutoff if s["patient_changes"] else None
        recent_move = a.moved_at is not None and now_ - aware(a.moved_at) <= moved_shown
        out.append(
            PatientAppointment(
                id=a.id,
                at=a.at,
                doctor_name=_doctor_name(db, a.doctor_id),
                can_ask=bool(until and now_ < until and not (latest and latest.status == "open")),
                ask_until=until,
                change=PatientChange(
                    id=latest.id,
                    days=list(latest.days),
                    part_of_day=latest.part_of_day,
                    reason=latest.reason,
                    status=latest.status,
                    answer=latest.answer,
                    created_at=latest.created_at,
                    answered_at=latest.answered_at,
                )
                if latest
                else None,
                moved_from=a.moved_from if recent_move else None,
                moved_from_doctor_name=_doctor_name(db, a.moved_from_doctor_id) if recent_move else None,
                moved_by_hospital=recent_move and a.moved_reason != "patient_request",
            )
        )
    return PatientAppointmentsOut(
        appointments=out,
        time_zone=s["time_zone"],
        max_days=int(cfg["maxDays"]),
        max_days_ahead=int(cfg["maxDaysAhead"]),
        cutoff_hours=int(s["change_cutoff_hours"]),
    )


class ChangeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    days: list[date] = Field(min_length=1, max_length=7)
    part_of_day: Literal["morning", "afternoon", "any"]
    reason: str | None = Field(default=None, max_length=20)


@router.post("/patient/appointments/{appt_id}/change-request", response_model=PatientChange, status_code=201)
def ask_change(
    appt_id: str,
    body: ChangeIn,
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> PatientChange:
    _patient_principal(p)
    a = db.get(Appointment, appt_id)
    if not a or a.patient_id != p.patient.patient_id or a.status != "booked":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "appointment not found")
    site = db.get(Site, a.site_id)
    s, cfg = site_settings(site), _cfg()
    now_ = datetime.now(UTC)
    if not s["patient_changes"]:
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "changes_off"})
    if now_ >= aware(a.at) - timedelta(hours=int(s["change_cutoff_hours"])):
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "too_late_to_change"})
    days = sorted(set(body.days))
    today = now_.astimezone(site_tz(site)).date()
    if len(days) > int(cfg["maxDays"]) or any(
        d < today or d > today + timedelta(days=int(cfg["maxDaysAhead"])) for d in days
    ):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "days_invalid"})
    if body.reason is not None and body.reason not in cfg["patientReasons"]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "reason_unknown"})
    open_ = db.scalar(
        select(AppointmentChangeRequest).where(
            AppointmentChangeRequest.appointment_id == a.id, AppointmentChangeRequest.status == "open"
        )
    )
    if open_:
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "change_already_asked"})
    c = AppointmentChangeRequest(
        site_id=a.site_id,
        patient_id=a.patient_id,
        appointment_id=a.id,
        days=[d.isoformat() for d in days],
        part_of_day=body.part_of_day,
        reason=body.reason,
    )
    db.add(c)
    db.flush()
    audit(
        db,
        "patient",
        p.actor_id,
        "change_requested",
        "appointment",
        a.id,
        site_id=a.site_id,
        days=c.days,
        part_of_day=c.part_of_day,
        reason=c.reason,
    )
    db.commit()
    return PatientChange(
        id=c.id,
        days=c.days,
        part_of_day=c.part_of_day,
        reason=c.reason,
        status=c.status,
        answer=None,
        created_at=c.created_at,
        answered_at=None,
    )


@router.post("/patient/change-requests/{req_id}/withdraw", status_code=204)
def withdraw_change(
    req_id: str,
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> None:
    _patient_principal(p)
    c = db.get(AppointmentChangeRequest, req_id)
    if not c or c.patient_id != p.patient.patient_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "request not found")
    if c.status != "open":
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "request_not_open"})
    c.status, c.answered_at = "withdrawn", datetime.now(UTC)
    audit(db, "patient", p.actor_id, "change_withdrawn", "appointment", c.appointment_id, site_id=c.site_id)
    db.commit()


# --- Notices for the hospital connector (SMS / e-mail) ---


class NoticeOut(BaseModel):
    id: str
    ncid: str
    #: moved | not_changed
    kind: str
    at: datetime
    #: The same time in the hospital's time zone (ISO with offset), for the message text.
    at_local: str
    doctor_name: str | None


@router.get("/connector/v1/appointment-notices/due", response_model=list[NoticeOut])
def notices_due(site: Site = Depends(signed_connector), db: DbSession = Depends(get_db)) -> list[NoticeOut]:  # noqa: B008
    tz = site_tz(site)
    since = datetime.now(UTC) - timedelta(days=7)
    q = (
        select(AppointmentNotice, Appointment, Patient.ncid)
        .join(Appointment, Appointment.id == AppointmentNotice.appointment_id)
        .join(Patient, Patient.id == AppointmentNotice.patient_id)
        .where(
            AppointmentNotice.site_id == site.id,
            AppointmentNotice.sent_at.is_(None),
            AppointmentNotice.created_at >= since,
        )
        .order_by(AppointmentNotice.created_at)
    )
    return [
        NoticeOut(
            id=n.id,
            ncid=ncid,
            kind=n.kind,
            at=a.at,
            at_local=aware(a.at).astimezone(tz).isoformat(),
            doctor_name=_doctor_name(db, a.doctor_id),
        )
        for n, a, ncid in db.execute(q)
    ]


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
    audit(
        db,
        "connector",
        site.id,
        "appointment_notice_sent",
        "appointment",
        n.appointment_id,
        site_id=site.id,
        kind=n.kind,
    )
    db.commit()
