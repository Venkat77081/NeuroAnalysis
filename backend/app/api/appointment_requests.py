"""v14 (decision 046): patients' requests and the desk's offers.

- **Change** (one appointment) and **booking** (a new appointment) requests: the patient picks
  exact free times on preferred and alternative dates (counts set by the hospital admin), with a
  reason or purpose code. No free text reaches the platform.
- The desk books one of the patient's times (or any other), declines with a reason, or **offers**
  up to `offer_max` times (date, time, doctor). Offered times are held for the patient until
  `reply_by`. The patient chooses one, keeps the current date (when still possible), asks to be
  called, or cancels. No answer by the deadline: the appointment stays as booked and the desk sees
  "No answer".
- Patients cancel any appointment at any time with a reason code; the desk sees it in its inbox.
"""

from datetime import UTC, date, datetime, time, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.api.appointment_changes import (
    apply_move,
    cancel_appointment,
    cfg,
    check_move,
    doctor_day,
    doctors_of,
    future,
    held_times,
    notice,
    utc,
)
from app.api.requests import AppointmentOut, _appointment, _appt_out, _doctor_name, _doctor_ok, aware
from app.audit import audit
from app.db import get_db
from app.hospital_settings import site_settings, site_tz
from app.models import (
    Appointment,
    AppointmentChangeRequest,
    AppointmentOffer,
    DoctorHours,
    Patient,
    PatientAccount,
    RecordingRequest,
    Site,
    StaffUser,
)
from app.permissions import allows, require
from app.security import Principal, current_principal

router = APIRouter(tags=["appointment requests"])
can_change = require("appointments.add", "appointments.assign")
can_view = require("appointments.view", "appointments.add", "appointments.assign")

PATIENT_SIDE = ("patient_request", "patient_choice")


def _now() -> datetime:
    return datetime.now(UTC)


def _bad(code: str, http: int = status.HTTP_422_UNPROCESSABLE_ENTITY):
    return HTTPException(http, {"code": code})


def _slot(db: DbSession, doctor_id: str | None) -> timedelta:
    h = db.get(DoctorHours, doctor_id) if doctor_id else None
    return timedelta(minutes=h.slot_minutes if h else int(cfg()["slotMinutes"]))


def _clash(db: DbSession, doctor_id: str, at: datetime, exclude: str | None) -> bool:
    """A booked appointment of this doctor overlaps `at`."""
    slot = _slot(db, doctor_id)
    return any(
        a.id != exclude
        for a in db.scalars(
            select(Appointment).where(
                Appointment.doctor_id == doctor_id,
                Appointment.status == "booked",
                Appointment.at > at - slot,
                Appointment.at < at + slot,
            )
        )
    )


def _choice_state(
    db: DbSession, site: Site, doctors: list[StaffUser], at: datetime, exclude: str | None
) -> tuple[str, str | None]:
    """(free | taken | leave | off | past, the doctor free at that time) now."""
    now_ = _now()
    at = utc(at)
    if at <= now_:
        return "past", None
    local = at.astimezone(site_tz(site))
    hhmm = local.strftime("%H:%M")
    held = held_times(db, site.id, now_)
    states = []
    for d in doctors:
        dd = doctor_day(db, site, d, local.date(), exclude, now_, held=held)
        if hhmm in dd.free:
            return "free", d.id
        states.append(
            "leave" if dd.on_leave else "taken" if any(a <= hhmm < b for a, b in dd.hours) else "off"
        )
    for s in ("taken", "leave", "off"):
        if s in states:
            return s, None
    return "off", None


# --- Shared shapes ---


class ChoiceIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    at: datetime
    rank: Literal["preferred", "alternative"]


class ChoiceOut(BaseModel):
    at: datetime
    rank: str
    #: Desk only: free | taken | leave | off | past, checked now; and who is free then.
    state: str | None = None
    doctor_id: str | None = None
    doctor_name: str | None = None


def _check_choices(site: Site, choices: list[ChoiceIn], *, booking: bool) -> list[dict]:
    s = site_settings(site)
    tz = site_tz(site)
    today = _now().astimezone(tz).date()
    first = today + timedelta(days=int(s["booking_min_days"]) if booking else 0)
    last = today + timedelta(days=int(s["booking_days_ahead"]) if booking else int(cfg()["maxDaysAhead"]))
    per_rank: dict[str, dict[date, int]] = {"preferred": {}, "alternative": {}}
    seen = set()
    for c in choices:
        at = utc(c.at)
        day = at.astimezone(tz).date()
        if at <= _now() or not first <= day <= last or at in seen:
            raise _bad("choices_invalid")
        seen.add(at)
        per_rank[c.rank][day] = per_rank[c.rank].get(day, 0) + 1
    limits = {"preferred": int(s["booking_preferred"]), "alternative": int(s["booking_alternatives"])}
    if not per_rank["preferred"]:
        raise _bad("choices_invalid")
    for rank, days in per_rank.items():
        if len(days) > limits[rank] or any(n > int(s["times_per_date"]) for n in days.values()):
            raise _bad("choices_invalid")
    return [
        {"at": utc(c.at).isoformat(), "rank": c.rank}
        for c in sorted(choices, key=lambda c: (c.rank != "preferred", c.at))
    ]


def _choices_out(
    db: DbSession, site: Site, c: AppointmentChangeRequest, a: Appointment | None, *, check: bool
) -> list[ChoiceOut]:
    if c.doctor_id:
        doctors = [d for d in [db.get(StaffUser, c.doctor_id)] if d and d.active]
    elif c.kind == "change" and a and a.doctor_id and not c.any_doctor:
        doctors = [d for d in [db.get(StaffUser, a.doctor_id)] if d and d.active]
    else:
        doctors = doctors_of(db, site.id)
    out = []
    for x in c.choices or []:
        at = datetime.fromisoformat(x["at"])
        st, doc = _choice_state(db, site, doctors, at, a.id if a else None) if check else (None, None)
        out.append(
            ChoiceOut(at=at, rank=x["rank"], state=st, doctor_id=doc, doctor_name=_doctor_name(db, doc))
        )
    return out


class OptionOut(BaseModel):
    index: int
    at: datetime
    doctor_id: str
    doctor_name: str | None
    #: Not the appointment's current doctor.
    other_doctor: bool


def _options_out(db: DbSession, o: AppointmentOffer, a: Appointment | None) -> list[OptionOut]:
    return [
        OptionOut(
            index=i,
            at=datetime.fromisoformat(x["at"]),
            doctor_id=x["doctor_id"],
            doctor_name=_doctor_name(db, x["doctor_id"]),
            other_doctor=bool(a and a.doctor_id and x["doctor_id"] != a.doctor_id),
        )
        for i, x in enumerate(o.options)
    ]


# --- The patient's app ---


class PatientOffer(BaseModel):
    id: str
    options: list[OptionOut]
    reply_by: datetime
    current_possible: bool
    reason: str
    #: open | call_requested
    status: str
    #: The deadline passed (the times are no longer held, but may still be free).
    late: bool


class PatientChange(BaseModel):
    id: str
    kind: str
    choices: list[ChoiceOut]
    days: list[str] | None = None
    part_of_day: str | None = None
    reason: str | None
    purpose: str | None = None
    #: open | offered | accepted | declined | withdrawn | closed
    status: str
    answer: str | None
    created_at: datetime
    answered_at: datetime | None


class PatientAppointment(BaseModel):
    id: str
    at: datetime
    doctor_name: str | None
    #: booked | cancelled
    status: str
    #: The patient may ask to change it now (on, before the cut-off, nothing open).
    can_ask: bool
    ask_until: datetime | None
    can_cancel: bool
    change: PatientChange | None
    offer: PatientOffer | None
    moved_from: datetime | None
    moved_from_doctor_name: str | None
    moved_by_hospital: bool
    cancelled_by: str | None
    cancel_reason: str | None
    #: The doctor changed before the patient recorded: the new doctor will send the tests.
    waiting_for_tests: bool


class PatientBooking(BaseModel):
    id: str
    status: str
    doctor_name: str | None
    any_doctor: bool
    choices: list[ChoiceOut]
    purpose: str | None
    answer: str | None
    offer: PatientOffer | None
    created_at: datetime


class BookingRules(BaseModel):
    enabled: bool
    preferred: int
    alternatives: int
    times_per_date: int
    days_ahead: int
    min_days: int


class PatientAppointmentsOut(BaseModel):
    appointments: list[PatientAppointment]
    bookings: list[PatientBooking]
    time_zone: str
    max_days: int
    max_days_ahead: int
    cutoff_hours: int
    changes_enabled: bool
    booking: BookingRules


def _patient(p: Principal) -> PatientAccount:
    if p.patient is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "patient sign-in required")
    return p.patient


def _offer_out(db: DbSession, o: AppointmentOffer | None, a: Appointment | None) -> PatientOffer | None:
    if o is None:
        return None
    return PatientOffer(
        id=o.id,
        options=_options_out(db, o, a),
        reply_by=o.reply_by,
        current_possible=o.current_possible,
        reason=o.reason,
        status=o.status,
        late=aware(o.reply_by) < _now(),
    )


def _open_offer(db: DbSession, *, appointment_id: str | None = None, request_id: str | None = None):
    q = select(AppointmentOffer).where(AppointmentOffer.status.in_(("open", "call_requested")))
    q = (
        q.where(AppointmentOffer.appointment_id == appointment_id)
        if appointment_id
        else q.where(AppointmentOffer.request_id == request_id)
    )
    return db.scalar(q.order_by(AppointmentOffer.created_at.desc()).limit(1))


def _change_out(
    db: DbSession, site: Site, c: AppointmentChangeRequest, a: Appointment | None
) -> PatientChange:
    return PatientChange(
        id=c.id,
        kind=c.kind,
        choices=_choices_out(db, site, c, a, check=False),
        days=c.days,
        part_of_day=c.part_of_day,
        reason=c.reason,
        purpose=c.purpose,
        status=c.status,
        answer=c.answer,
        created_at=c.created_at,
        answered_at=c.answered_at,
    )


@router.get("/patient/appointments", response_model=PatientAppointmentsOut)
def patient_appointments(
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> PatientAppointmentsOut:
    """The signed-in patient's appointments at this hospital (upcoming, and recently cancelled),
    their requests and the desk's offers."""
    acc = _patient(p)
    site = db.get(Site, acc.site_id)
    s, c = site_settings(site), cfg()
    now_ = _now()
    shown = timedelta(days=int(c["answerShownDays"]))
    moved_shown = timedelta(days=int(c["movedShownDays"]))
    cancelled_shown = timedelta(days=int(c["cancelledShownDays"]))
    cutoff = timedelta(hours=int(s["change_cutoff_hours"]))
    out = []
    q = (
        select(Appointment)
        .where(Appointment.patient_id == acc.patient_id, Appointment.at >= now_ - timedelta(hours=12))
        .order_by(Appointment.at)
        .limit(30)
    )
    for a in db.scalars(q):
        if a.status == "cancelled" and not (
            a.cancelled_at and now_ - aware(a.cancelled_at) <= cancelled_shown
        ):
            continue
        booked = a.status == "booked" and aware(a.at) >= now_
        if a.status == "booked" and not booked:
            continue
        latest = db.scalar(
            select(AppointmentChangeRequest)
            .where(AppointmentChangeRequest.appointment_id == a.id, AppointmentChangeRequest.kind == "change")
            .order_by(AppointmentChangeRequest.created_at.desc())
            .limit(1)
        )
        if (
            latest
            and latest.status not in ("open", "offered")
            and (
                latest.status == "withdrawn" or now_ - aware(latest.answered_at or latest.created_at) > shown
            )
        ):
            latest = None
        offer = _open_offer(db, appointment_id=a.id) if booked else None
        until = aware(a.at) - cutoff if s["patient_changes"] and booked else None
        recent_move = a.moved_at is not None and now_ - aware(a.moved_at) <= moved_shown
        busy = (latest and latest.status in ("open", "offered")) or offer is not None
        out.append(
            PatientAppointment(
                id=a.id,
                at=a.at,
                doctor_name=_doctor_name(db, a.doctor_id),
                status=a.status,
                can_ask=bool(until and now_ < until and not busy),
                ask_until=until,
                can_cancel=booked,
                change=_change_out(db, site, latest, a) if latest else None,
                offer=_offer_out(db, offer, a),
                moved_from=a.moved_from if recent_move else None,
                moved_from_doctor_name=_doctor_name(db, a.moved_from_doctor_id) if recent_move else None,
                moved_by_hospital=recent_move and a.moved_reason not in PATIENT_SIDE,
                cancelled_by=a.cancelled_by,
                cancel_reason=a.cancel_reason,
                waiting_for_tests=booked and a.suggested_tests is not None,
            )
        )
    bookings = []
    for b in db.scalars(
        select(AppointmentChangeRequest)
        .where(
            AppointmentChangeRequest.patient_id == acc.patient_id, AppointmentChangeRequest.kind == "booking"
        )
        .order_by(AppointmentChangeRequest.created_at.desc())
        .limit(20)
    ):
        if b.status in ("accepted", "withdrawn", "closed"):
            continue
        if b.status == "declined" and now_ - aware(b.answered_at or b.created_at) > shown:
            continue
        bookings.append(
            PatientBooking(
                id=b.id,
                status=b.status,
                doctor_name=_doctor_name(db, b.doctor_id),
                any_doctor=b.doctor_id is None,
                choices=_choices_out(db, site, b, None, check=False),
                purpose=b.purpose,
                answer=b.answer,
                offer=_offer_out(db, _open_offer(db, request_id=b.id), None),
                created_at=b.created_at,
            )
        )
    return PatientAppointmentsOut(
        appointments=out,
        bookings=bookings,
        time_zone=s["time_zone"],
        max_days=int(s["booking_preferred"]) + int(s["booking_alternatives"]),
        max_days_ahead=int(c["maxDaysAhead"]),
        cutoff_hours=int(s["change_cutoff_hours"]),
        changes_enabled=bool(s["patient_changes"]),
        booking=BookingRules(
            enabled=bool(s["patient_booking"]),
            preferred=int(s["booking_preferred"]),
            alternatives=int(s["booking_alternatives"]),
            times_per_date=int(s["times_per_date"]),
            days_ahead=int(s["booking_days_ahead"]),
            min_days=int(s["booking_min_days"]),
        ),
    )


class PatientDoctor(BaseModel):
    id: str
    name: str
    department: str | None


@router.get("/patient/doctors", response_model=list[PatientDoctor])
def patient_doctors(
    p: Principal = Depends(current_principal), db: DbSession = Depends(get_db)
) -> list[PatientDoctor]:  # noqa: B008
    """Doctors bookable in the app (with clinic hours)."""
    acc = _patient(p)
    out = []
    for d in doctors_of(db, acc.site_id):
        h = db.get(DoctorHours, d.id)
        if h and h.week and h.bookable:
            out.append(PatientDoctor(id=d.id, name=d.display_name or d.email, department=h.department))
    return out


class FreeTime(BaseModel):
    time: str
    doctor_id: str


class FreeTimesOut(BaseModel):
    date: date
    times: list[FreeTime]


def _free_setup(db: DbSession, acc, doctor_id: str | None, appointment_id: str | None):
    """Which doctors, which appointment (when changing one) and the earliest bookable moment."""
    site = db.get(Site, acc.site_id)
    a = db.get(Appointment, appointment_id) if appointment_id else None
    if appointment_id and (not a or a.patient_id != acc.patient_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "appointment not found")
    if doctor_id:
        d = db.get(StaffUser, doctor_id)
        if not d or d.site_id != acc.site_id or d.role != "doctor" or not d.active:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "doctor not found")
        doctors = [d]
    elif a and a.doctor_id:
        doctors = [d for d in [db.get(StaffUser, a.doctor_id)] if d and d.active]
    else:
        doctors = [d for d in doctors_of(db, site.id) if (h := db.get(DoctorHours, d.id)) and h.bookable]
    now_ = _now()
    not_before = None
    if a is None:
        tz = site_tz(site)
        first = now_.astimezone(tz).date() + timedelta(days=int(site_settings(site)["booking_min_days"]))
        not_before = datetime.combine(first, time(0), tzinfo=tz)
    return site, a, doctors, now_, not_before


def _free_on(db, site, a, doctors, now_, not_before, held, day: date) -> dict[str, str]:
    times: dict[str, str] = {}
    for d in doctors:
        for t in doctor_day(
            db, site, d, day, a.id if a else None, now_, held=held, not_before=not_before
        ).free:
            times.setdefault(t, d.id)
    return times


@router.get("/patient/free-times", response_model=FreeTimesOut)
def patient_free_times(
    day: date = Query(alias="date"),
    doctor_id: str | None = Query(default=None, max_length=32),
    appointment_id: str | None = Query(default=None, max_length=32),
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> FreeTimesOut:
    """Free times on one day: with one doctor, the appointment's doctor (changing it), or any
    bookable doctor. Booking: not before `booking_min_days`."""
    acc = _patient(p)
    site, a, doctors, now_, not_before = _free_setup(db, acc, doctor_id, appointment_id)
    held = held_times(db, site.id, now_)
    times = _free_on(db, site, a, doctors, now_, not_before, held, day)
    return FreeTimesOut(date=day, times=[FreeTime(time=t, doctor_id=times[t]) for t in sorted(times)])


class FreeDay(BaseModel):
    date: date
    free: int


class FreeDaysOut(BaseModel):
    days: list[FreeDay]


@router.get("/patient/free-days", response_model=FreeDaysOut)
def patient_free_days(
    start: date = Query(alias="from"),
    end: date = Query(alias="to"),
    doctor_id: str | None = Query(default=None, max_length=32),
    appointment_id: str | None = Query(default=None, max_length=32),
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> FreeDaysOut:
    """v17: how many free times each day has, for the app's calendar (a month at a time)."""
    acc = _patient(p)
    if end < start or (end - start).days + 1 > int(cfg()["freeDaysMaxSpan"]):
        raise _bad("range_too_long")
    site, a, doctors, now_, not_before = _free_setup(db, acc, doctor_id, appointment_id)
    held = held_times(db, site.id, now_)
    out, day = [], start
    while day <= end:
        out.append(FreeDay(date=day, free=len(_free_on(db, site, a, doctors, now_, not_before, held, day))))
        day += timedelta(days=1)
    return FreeDaysOut(days=out)


class PastAppointment(BaseModel):
    id: str
    at: datetime
    doctor_name: str | None
    #: past (booked, date gone by) | cancelled | no_show (v18: the desk marked they did not come)
    status: Literal["past", "cancelled", "no_show"]
    cancelled_by: str | None
    cancel_reason: str | None
    moved_from: datetime | None
    moved_by_hospital: bool


@router.get("/patient/appointments/history", response_model=list[PastAppointment])
def patient_appointment_history(
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> list[PastAppointment]:
    """v17: the patient's past and cancelled appointments at this hospital, newest first. Only
    dates, doctors and what happened; no notes or results."""
    acc = _patient(p)
    now_ = _now()
    out = []
    for a in db.scalars(
        select(Appointment)
        .where(
            Appointment.patient_id == acc.patient_id,
            (Appointment.status == "cancelled") | (Appointment.at < now_),
        )
        .order_by(Appointment.at.desc())
        .limit(int(cfg()["patientHistoryMax"]))
    ):
        out.append(
            PastAppointment(
                id=a.id,
                at=a.at,
                doctor_name=_doctor_name(db, a.doctor_id),
                status=(
                    "past"
                    if a.status != "cancelled"
                    else "no_show"
                    if a.cancel_reason == "no_show"
                    else "cancelled"
                ),
                cancelled_by=a.cancelled_by,
                cancel_reason=a.cancel_reason,
                moved_from=a.moved_from,
                moved_by_hospital=a.moved_from is not None and a.moved_reason not in PATIENT_SIDE,
            )
        )
    return out


class ChangeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    choices: list[ChoiceIn] = Field(min_length=1, max_length=20)
    #: Another doctor is fine too.
    any_doctor: bool = False
    reason: str | None = Field(default=None, max_length=20)


@router.post("/patient/appointments/{appt_id}/change-request", response_model=PatientChange, status_code=201)
def ask_change(
    appt_id: str,
    body: ChangeIn,
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> PatientChange:
    acc = _patient(p)
    a = db.get(Appointment, appt_id)
    if not a or a.patient_id != acc.patient_id or a.status != "booked":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "appointment not found")
    site = db.get(Site, a.site_id)
    s = site_settings(site)
    if not s["patient_changes"]:
        raise _bad("changes_off", status.HTTP_409_CONFLICT)
    if _now() >= aware(a.at) - timedelta(hours=int(s["change_cutoff_hours"])):
        raise _bad("too_late_to_change", status.HTTP_409_CONFLICT)
    if body.reason is not None and body.reason not in cfg()["patientReasons"]:
        raise _bad("reason_unknown")
    choices = _check_choices(site, body.choices, booking=False)
    busy = db.scalar(
        select(AppointmentChangeRequest).where(
            AppointmentChangeRequest.appointment_id == a.id,
            AppointmentChangeRequest.status.in_(("open", "offered")),
        )
    )
    if busy or _open_offer(db, appointment_id=a.id):
        raise _bad("change_already_asked", status.HTTP_409_CONFLICT)
    c = AppointmentChangeRequest(
        site_id=a.site_id,
        patient_id=a.patient_id,
        appointment_id=a.id,
        kind="change",
        any_doctor=body.any_doctor,
        choices=choices,
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
        options=len(choices),
        reason=c.reason,
    )
    db.commit()
    return _change_out(db, site, c, a)


class BookingIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: Null: any doctor.
    doctor_id: str | None = Field(default=None, max_length=32)
    choices: list[ChoiceIn] = Field(min_length=1, max_length=20)
    purpose: str | None = Field(default=None, max_length=20)


@router.post("/patient/bookings", response_model=PatientBooking, status_code=201)
def ask_booking(
    body: BookingIn,
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> PatientBooking:
    acc = _patient(p)
    if acc.status != "active":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "not joined")
    site = db.get(Site, acc.site_id)
    if not site_settings(site)["patient_booking"]:
        raise _bad("booking_off", status.HTTP_409_CONFLICT)
    if body.doctor_id:
        d = db.get(StaffUser, body.doctor_id)
        h = db.get(DoctorHours, body.doctor_id)
        if not d or d.site_id != site.id or d.role != "doctor" or not d.active or (h and not h.bookable):
            raise _bad("doctor_not_bookable")
    if body.purpose is not None and body.purpose not in cfg()["bookingPurposes"]:
        raise _bad("reason_unknown")
    open_ = db.scalar(
        select(AppointmentChangeRequest).where(
            AppointmentChangeRequest.patient_id == acc.patient_id,
            AppointmentChangeRequest.kind == "booking",
            AppointmentChangeRequest.status.in_(("open", "offered")),
        )
    )
    if open_:
        raise _bad("booking_already_asked", status.HTTP_409_CONFLICT)
    b = AppointmentChangeRequest(
        site_id=site.id,
        patient_id=acc.patient_id,
        kind="booking",
        doctor_id=body.doctor_id,
        choices=_check_choices(site, body.choices, booking=True),
        purpose=body.purpose,
    )
    db.add(b)
    db.flush()
    audit(
        db,
        "patient",
        p.actor_id,
        "booking_requested",
        "patient",
        acc.patient_id,
        site_id=site.id,
        doctor=body.doctor_id,
        purpose=body.purpose,
        options=len(b.choices),
    )
    db.commit()
    return PatientBooking(
        id=b.id,
        status=b.status,
        doctor_name=_doctor_name(db, b.doctor_id),
        any_doctor=b.doctor_id is None,
        choices=_choices_out(db, site, b, None, check=False),
        purpose=b.purpose,
        answer=None,
        offer=None,
        created_at=b.created_at,
    )


@router.post("/patient/change-requests/{req_id}/withdraw", status_code=204)
def withdraw_request(
    req_id: str,
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> None:
    """Change or booking request; an offer made for it is closed too."""
    acc = _patient(p)
    c = db.get(AppointmentChangeRequest, req_id)
    if not c or c.patient_id != acc.patient_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "request not found")
    if c.status not in ("open", "offered"):
        raise _bad("request_not_open", status.HTTP_409_CONFLICT)
    c.status, c.answered_at = "withdrawn", _now()
    o = _open_offer(db, request_id=c.id)
    if o:
        o.status, o.answered_at = "closed", _now()
    target = ("appointment", c.appointment_id) if c.appointment_id else ("patient", c.patient_id)
    audit(db, "patient", p.actor_id, "change_withdrawn", *target, site_id=c.site_id, kind=c.kind)
    db.commit()


class PatientCancelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str | None = Field(default=None, max_length=24)


def _patient_cancel(db: DbSession, p: Principal, a: Appointment, reason: str | None) -> None:
    if reason is not None and reason not in cfg()["patientCancelReasons"]:
        raise _bad("reason_unknown")
    cancel_appointment(db, a, "patient", p.actor_id, "patient", reason or "other")


@router.post("/patient/appointments/{appt_id}/cancel", status_code=204)
def patient_cancel(
    appt_id: str,
    body: PatientCancelIn,
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> None:
    """Any time, with a reason from a list. The desk sees it in its inbox."""
    acc = _patient(p)
    a = db.get(Appointment, appt_id)
    if not a or a.patient_id != acc.patient_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "appointment not found")
    if a.status != "booked":
        raise _bad("appointment_cancelled", status.HTTP_409_CONFLICT)
    _patient_cancel(db, p, a, body.reason)
    db.commit()


def _my_offer(db: DbSession, p: Principal, offer_id: str) -> AppointmentOffer:
    acc = _patient(p)
    o = db.get(AppointmentOffer, offer_id)
    if not o or o.patient_id != acc.patient_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "offer not found")
    if o.status not in ("open", "call_requested"):
        raise _bad("offer_not_open", status.HTTP_409_CONFLICT)
    return o


class ChooseIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    index: int = Field(ge=0, le=9)


def new_appointment(
    db: DbSession, site_id: str, patient_id: str, at: datetime, doctor_id: str, by: str, actor_type: str
) -> Appointment:
    a = Appointment(
        site_id=site_id, patient_id=patient_id, at=at, doctor_id=doctor_id, source="app", created_by=by
    )
    db.add(a)
    db.flush()
    audit(
        db,
        actor_type,
        by,
        "appointment_added",
        "appointment",
        a.id,
        site_id=site_id,
        source="app",
        at=at.isoformat(),
        doctor=doctor_id,
    )
    return a


@router.post("/patient/offers/{offer_id}/choose", response_model=PatientOffer)
def choose_offer(
    offer_id: str,
    body: ChooseIn,
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> PatientOffer:
    """Book one of the offered times (still held, or else still free)."""
    o = _my_offer(db, p, offer_id)
    if body.index >= len(o.options):
        raise _bad("option_unknown")
    opt = o.options[body.index]
    at, doctor = datetime.fromisoformat(opt["at"]), opt["doctor_id"]
    if utc(at) <= _now() or _clash(db, doctor, utc(at), o.appointment_id):
        raise _bad("time_taken", status.HTTP_409_CONFLICT)
    req = db.get(AppointmentChangeRequest, o.request_id) if o.request_id else None
    if o.appointment_id:
        a = db.get(Appointment, o.appointment_id)
        if not a or a.status != "booked":
            raise _bad("appointment_cancelled", status.HTTP_409_CONFLICT)
        apply_move(db, p, a, utc(at), doctor, "patient_choice", accepted=req)
    else:
        a = new_appointment(db, o.site_id, o.patient_id, utc(at), doctor, p.actor_id, "patient")
        if req:
            req.status, req.appointment_id, req.answered_at = "accepted", a.id, _now()
    o.status, o.chosen, o.answered_at = "chosen", body.index, _now()
    audit(
        db,
        "patient",
        p.actor_id,
        "offer_chosen",
        "appointment",
        a.id,
        site_id=o.site_id,
        at=utc(at).isoformat(),
    )
    db.commit()
    return _offer_out(db, o, a)


@router.post("/patient/offers/{offer_id}/keep", status_code=204)
def keep_current(
    offer_id: str, p: Principal = Depends(current_principal), db: DbSession = Depends(get_db)
) -> None:  # noqa: B008
    o = _my_offer(db, p, offer_id)
    if not o.current_possible or not o.appointment_id:
        raise _bad("cannot_keep", status.HTTP_409_CONFLICT)
    o.status, o.answered_at = "kept", _now()
    audit(db, "patient", p.actor_id, "offer_kept", "appointment", o.appointment_id, site_id=o.site_id)
    db.commit()


@router.post("/patient/offers/{offer_id}/call", status_code=204)
def ask_call(
    offer_id: str, p: Principal = Depends(current_principal), db: DbSession = Depends(get_db)
) -> None:  # noqa: B008
    """None of the times work: please call me. The times stay held until the deadline."""
    o = _my_offer(db, p, offer_id)
    o.status = "call_requested"
    target = ("appointment", o.appointment_id) if o.appointment_id else ("patient", o.patient_id)
    audit(db, "patient", p.actor_id, "call_requested", *target, site_id=o.site_id)
    db.commit()


@router.post("/patient/offers/{offer_id}/decline", status_code=204)
def decline_offer(
    offer_id: str,
    body: PatientCancelIn,
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> None:
    """None of the times work: cancel the appointment (or, for a booking, the request)."""
    o = _my_offer(db, p, offer_id)
    o.status, o.answered_at = "declined", _now()
    if o.appointment_id:
        a = db.get(Appointment, o.appointment_id)
        if a and a.status == "booked":
            _patient_cancel(db, p, a, body.reason)
    elif o.request_id:
        req = db.get(AppointmentChangeRequest, o.request_id)
        if req and req.status in ("open", "offered"):
            req.status, req.answered_at = "withdrawn", _now()
        audit(
            db,
            "patient",
            p.actor_id,
            "change_withdrawn",
            "patient",
            o.patient_id,
            site_id=o.site_id,
            kind="booking",
        )
    db.commit()


# --- The front desk ---


class RequestOut(BaseModel):
    id: str
    #: change | booking
    kind: str
    ncid: str
    appointment_id: str | None
    appointment_at: datetime | None
    source: str | None
    #: The appointment's doctor (change) or the preferred one (booking; null = any).
    doctor_id: str | None
    doctor_name: str | None
    any_doctor: bool
    places: list[str]
    choices: list[ChoiceOut]
    #: v13 requests: days and part of day instead of exact times.
    days: list[str] | None = None
    part_of_day: str | None = None
    reason: str | None
    purpose: str | None
    status: str
    created_at: datetime
    #: The patient has the app (an offer can be sent).
    joined: bool


class OfferOut(BaseModel):
    id: str
    kind: str
    ncid: str
    appointment_id: str | None
    appointment_at: datetime | None
    doctor_name: str | None
    options: list[OptionOut]
    reply_by: datetime
    #: open | call_requested
    status: str
    no_answer: bool
    current_possible: bool
    reason: str
    created_at: datetime


class CancellationOut(BaseModel):
    appointment_id: str
    ncid: str
    at: datetime
    doctor_name: str | None
    reason: str | None
    cancelled_at: datetime | None


class InboxOut(BaseModel):
    requests: list[RequestOut]
    offers: list[OfferOut]
    cancellations: list[CancellationOut]
    #: What needs the desk: requests, offers with no answer or a call asked for.
    count: int


def _joined(db: DbSession, patient_id: str) -> bool:
    acc = db.scalar(select(PatientAccount).where(PatientAccount.patient_id == patient_id))
    return bool(acc and acc.status == "active")


def request_out(db: DbSession, site: Site, c: AppointmentChangeRequest, ncid: str) -> RequestOut:
    a = db.get(Appointment, c.appointment_id) if c.appointment_id else None
    places = (
        sorted(
            {
                r.place
                for r in db.scalars(select(RecordingRequest).where(RecordingRequest.appointment_id == a.id))
                if r.status != "cancelled"
            }
        )
        if a
        else []
    )
    doctor = a.doctor_id if a and c.kind == "change" else c.doctor_id
    return RequestOut(
        id=c.id,
        kind=c.kind,
        ncid=ncid,
        appointment_id=a.id if a else None,
        appointment_at=a.at if a else None,
        source=a.source if a else None,
        doctor_id=doctor,
        doctor_name=_doctor_name(db, doctor),
        any_doctor=c.any_doctor or (c.kind == "booking" and c.doctor_id is None),
        places=places,
        choices=_choices_out(db, site, c, a, check=c.status == "open"),
        days=c.days,
        part_of_day=c.part_of_day,
        reason=c.reason,
        purpose=c.purpose,
        status=c.status,
        created_at=c.created_at,
        joined=_joined(db, c.patient_id),
    )


def _mine(q, p: Principal, col):
    return q.where(col == p.actor_id) if p.role == "doctor" else q


@router.get("/hospital/inbox", response_model=InboxOut)
def inbox(p: Principal = Depends(can_view), db: DbSession = Depends(get_db)) -> InboxOut:  # noqa: B008
    site = db.get(Site, p.site_id)
    now_ = _now()
    reqs = []
    q = (
        select(AppointmentChangeRequest, Patient.ncid)
        .join(Patient, Patient.id == AppointmentChangeRequest.patient_id)
        .where(AppointmentChangeRequest.site_id == p.site_id, AppointmentChangeRequest.status == "open")
        .order_by(AppointmentChangeRequest.created_at)
    )
    for c, ncid in db.execute(q):
        r = request_out(db, site, c, ncid)
        if p.role != "doctor" or r.doctor_id == p.actor_id:
            reqs.append(r)
    offers = []
    q = (
        select(AppointmentOffer, Patient.ncid)
        .join(Patient, Patient.id == AppointmentOffer.patient_id)
        .where(AppointmentOffer.site_id == p.site_id, AppointmentOffer.status.in_(("open", "call_requested")))
        .order_by(AppointmentOffer.reply_by)
    )
    for o, ncid in db.execute(q):
        a = db.get(Appointment, o.appointment_id) if o.appointment_id else None
        if p.role == "doctor" and not (a and a.doctor_id == p.actor_id):
            continue
        offers.append(
            OfferOut(
                id=o.id,
                kind="change" if a else "booking",
                ncid=ncid,
                appointment_id=a.id if a else None,
                appointment_at=a.at if a else None,
                doctor_name=_doctor_name(db, a.doctor_id) if a else None,
                options=_options_out(db, o, a),
                reply_by=o.reply_by,
                status=o.status,
                no_answer=aware(o.reply_by) < now_,
                current_possible=o.current_possible,
                reason=o.reason,
                created_at=o.created_at,
            )
        )
    cancels = []
    q = _mine(
        select(Appointment, Patient.ncid)
        .join(Patient, Patient.id == Appointment.patient_id)
        .where(
            Appointment.site_id == p.site_id,
            Appointment.status == "cancelled",
            Appointment.cancelled_by == "patient",
            Appointment.cancel_seen_at.is_(None),
        )
        .order_by(Appointment.cancelled_at.desc()),
        p,
        Appointment.doctor_id,
    )
    for a, ncid in db.execute(q):
        cancels.append(
            CancellationOut(
                appointment_id=a.id,
                ncid=ncid,
                at=a.at,
                doctor_name=_doctor_name(db, a.doctor_id),
                reason=a.cancel_reason,
                cancelled_at=a.cancelled_at,
            )
        )
    count = len(reqs) + sum(1 for o in offers if o.no_answer or o.status == "call_requested")
    return InboxOut(requests=reqs, offers=offers, cancellations=cancels, count=count)


@router.get("/hospital/change-requests", response_model=list[RequestOut])
def list_change_requests(
    p: Principal = Depends(can_view), db: DbSession = Depends(get_db)
) -> list[RequestOut]:  # noqa: B008
    """Open requests (changes and bookings), oldest first (v13 name, kept)."""
    return inbox(p, db).requests


def _request(db: DbSession, p: Principal, req_id: str) -> AppointmentChangeRequest:
    c = db.get(AppointmentChangeRequest, req_id)
    if not c or c.site_id != p.site_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "request not found")
    if c.status not in ("open", "offered"):
        raise _bad("request_not_open", status.HTTP_409_CONFLICT)
    return c


class BookIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    at: datetime
    #: Change: omitted = the same doctor. Booking: required unless the patient chose a doctor.
    doctor_id: str | None = Field(default=None, max_length=32)
    notify: bool = True


@router.post("/hospital/change-requests/{req_id}/book", response_model=AppointmentOut)
def book_request(
    req_id: str,
    body: BookIn,
    p: Principal = Depends(can_change),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> AppointmentOut:
    """Book one of the patient's times (or any other): moves the appointment, or creates it."""
    c = _request(db, p, req_id)
    at = future(body.at)
    pt = db.get(Patient, c.patient_id)
    if c.kind == "change":
        a, _ = _appointment(db, p, c.appointment_id)
        check_move(db, p, a, body.doctor_id)
        apply_move(db, p, a, at, body.doctor_id, "patient_request", accepted=c)
        if body.notify:
            notice(db, a.site_id, a.patient_id, "moved", appointment_id=a.id)
    else:
        if not allows(db, p, "appointments.add"):
            raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "not_permitted"})
        doctor = body.doctor_id or c.doctor_id
        if not doctor:
            raise _bad("doctor_required")
        _doctor_ok(db, p, doctor)
        a = new_appointment(db, c.site_id, c.patient_id, at, doctor, p.actor_id, p.actor_type)
        c.status, c.appointment_id, c.answered_by, c.answered_at = "accepted", a.id, p.actor_id, _now()
        o = _open_offer(db, request_id=c.id)
        if o:
            o.status, o.answered_at = "closed", _now()
        if body.notify:
            notice(db, a.site_id, a.patient_id, "booked", appointment_id=a.id)
    db.commit()
    return _appt_out(db, a, pt.ncid)


class DeclineIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    answer: str = Field(max_length=20)
    notify: bool = True


@router.post("/hospital/change-requests/{req_id}/decline", response_model=RequestOut)
def decline_request(
    req_id: str,
    body: DeclineIn,
    p: Principal = Depends(can_change),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> RequestOut:
    c = _request(db, p, req_id)
    answers = cfg()["declineAnswers"] if c.kind == "change" else cfg()["bookingDeclineAnswers"]
    if body.answer not in answers:
        raise _bad("answer_unknown")
    c.status, c.answer, c.answered_by, c.answered_at = "declined", body.answer, p.actor_id, _now()
    o = _open_offer(db, request_id=c.id)
    if o:
        o.status, o.answered_at = "closed", _now()
    target = ("appointment", c.appointment_id) if c.appointment_id else ("patient", c.patient_id)
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "change_declined",
        *target,
        site_id=p.site_id,
        answer=body.answer,
        kind=c.kind,
    )
    if body.notify:
        notice(
            db,
            c.site_id,
            c.patient_id,
            "not_changed" if c.kind == "change" else "not_booked",
            appointment_id=c.appointment_id,
        )
    db.commit()
    return request_out(db, db.get(Site, p.site_id), c, db.get(Patient, c.patient_id).ncid)


class OptionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    at: datetime
    doctor_id: str = Field(max_length=32)


class OfferIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: One of the two: the appointment to move, or the patient's request it answers.
    appointment_id: str | None = Field(default=None, max_length=32)
    request_id: str | None = Field(default=None, max_length=32)
    options: list[OptionIn] = Field(min_length=1, max_length=5)
    #: The current date may still be kept.
    current_possible: bool = False
    reason: str = Field(default="other", max_length=24)
    notify: bool = True


@router.post("/hospital/offers", response_model=OfferOut, status_code=201)
def make_offer(
    body: OfferIn,
    p: Principal = Depends(can_change),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> OfferOut:
    """Send the patient up to `offer_max` times to choose from; they are held until `reply_by`."""
    site = db.get(Site, p.site_id)
    s = site_settings(site)
    req = _request(db, p, body.request_id) if body.request_id else None
    appt_id = body.appointment_id or (req.appointment_id if req else None)
    if not appt_id and not req:
        raise _bad("offer_target")
    a = _appointment(db, p, appt_id)[0] if appt_id else None
    if a:
        check_move(db, p, a, None)
    elif not allows(db, p, "appointments.add"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "not_permitted"})
    patient_id = a.patient_id if a else req.patient_id
    if not _joined(db, patient_id):
        raise _bad("not_joined", status.HTTP_409_CONFLICT)
    if len(body.options) > int(s["offer_max"]):
        raise _bad("too_many_options")
    if body.reason not in cfg()["deskReasons"]:
        raise _bad("reason_unknown")
    seen = set()
    options = []
    for x in body.options:
        at = future(x.at)
        if (at, x.doctor_id) in seen:
            raise _bad("options_invalid")
        seen.add((at, x.doctor_id))
        if not (a and x.doctor_id == a.doctor_id):
            _doctor_ok(db, p, x.doctor_id)
            if a and not allows(db, p, "appointments.assign"):
                raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "not_permitted"})
        options.append({"at": at.isoformat(), "doctor_id": x.doctor_id})
    for old in db.scalars(
        select(AppointmentOffer).where(
            AppointmentOffer.status.in_(("open", "call_requested")),
            (AppointmentOffer.appointment_id == a.id) if a else (AppointmentOffer.request_id == req.id),
        )
    ):
        old.status, old.answered_at = "withdrawn", _now()
    o = AppointmentOffer(
        site_id=p.site_id,
        patient_id=patient_id,
        appointment_id=a.id if a else None,
        request_id=req.id if req else None,
        options=options,
        current_possible=body.current_possible and a is not None,
        reason=body.reason,
        reply_by=_now() + timedelta(hours=int(s["offer_reply_hours"])),
        created_by=p.actor_id,
    )
    db.add(o)
    db.flush()
    if req:
        req.status = "offered"
    target = ("appointment", a.id) if a else ("patient", patient_id)
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "times_offered",
        *target,
        site_id=p.site_id,
        options=len(options),
        reason=body.reason,
    )
    if body.notify:
        notice(db, p.site_id, patient_id, "offer", appointment_id=a.id if a else None, offer_id=o.id)
    db.commit()
    pt = db.get(Patient, patient_id)
    return OfferOut(
        id=o.id,
        kind="change" if a else "booking",
        ncid=pt.ncid,
        appointment_id=a.id if a else None,
        appointment_at=a.at if a else None,
        doctor_name=_doctor_name(db, a.doctor_id) if a else None,
        options=_options_out(db, o, a),
        reply_by=o.reply_by,
        status=o.status,
        no_answer=False,
        current_possible=o.current_possible,
        reason=o.reason,
        created_at=o.created_at,
    )


@router.post("/hospital/offers/{offer_id}/withdraw", status_code=204)
def withdraw_offer(
    offer_id: str, p: Principal = Depends(can_change), db: DbSession = Depends(get_db)
) -> None:  # noqa: B008
    """The desk takes the offer back (for example after phoning the patient)."""
    o = db.get(AppointmentOffer, offer_id)
    if not o or o.site_id != p.site_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "offer not found")
    if o.status not in ("open", "call_requested"):
        raise _bad("offer_not_open", status.HTTP_409_CONFLICT)
    o.status, o.answered_at = "withdrawn", _now()
    req = db.get(AppointmentChangeRequest, o.request_id) if o.request_id else None
    if req and req.status == "offered":
        req.status = "open"
    target = ("appointment", o.appointment_id) if o.appointment_id else ("patient", o.patient_id)
    audit(db, p.actor_type, p.actor_id, "offer_withdrawn", *target, site_id=p.site_id)
    db.commit()
