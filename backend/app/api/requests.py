"""v3: appointments and recording requests.

- Reception (receptionist, hospital admin) keeps the hospital's appointments here (read from its
  FHIR system through the connector, or entered by hand) and assigns the doctor.
- The assigned doctor chooses the tests and sends the patient the record link (a recording
  request: these tests, by this date; optionally also "repeat every N days"). Nothing reaches
  the patient before that.
- Doctors see their patients' appointment history and ask to record again.
- The patient's app lists open requests and the history, per hospital.
- The hospital connector collects due reminders and sends them (the platform has no contacts).
Only a time, a doctor and the tests asked for are kept; appointment details stay at the hospital.
"""

from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session as DbSession

from app.api.connector_link import signed_connector
from app.audit import audit
from app.db import get_db
from app.hospital_settings import site_settings
from app.models import (
    Appointment,
    AppointmentChangeRequest,
    AppointmentOffer,
    AuditEvent,
    Patient,
    PatientAccount,
    RecordingPlan,
    RecordingRequest,
    Session,
    Site,
    StaffUser,
    Take,
)
from app.permissions import allows, require
from app.policy import policy
from app.security import Principal, current_principal, sha256_hex
from app.test_lengths import default_lengths, offered

router = APIRouter(tags=["appointments"])
# Decision 033: what each role may do is set per hospital (config/platform.json `permissions`).
can_view = require("appointments.view", "appointments.add", "appointments.assign")
can_add = require("appointments.add")
can_change = require("appointments.add", "appointments.assign")
can_send = require("requests.send")
can_rerecord = require("requests.rerecord")
can_view_or_send = require("appointments.view", "requests.send")

TestCode = Literal["FT", "FTF", "FR", "SAW", "FA"]
ORDER = ["FT", "FTF", "FR", "SAW", "FA"]


def aware(dt: datetime | None) -> datetime | None:
    return dt if dt is None or dt.tzinfo else dt.replace(tzinfo=UTC)


def _patient(db: DbSession, p: Principal, ncid: str, *, clinical: bool = True, view: bool = False) -> Patient:
    """`clinical=False` for booking work (adding an appointment, choosing its doctor): a doctor who
    may book appointments at this hospital is not limited to their assigned patients for that.
    `view=True`: reading only, where view-only access after a move counts (decision 061)."""
    from app.assignments import check_patient_access

    pt = db.scalar(select(Patient).where(Patient.ncid == ncid, Patient.site_id == p.site_id))
    if not pt:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient not found")
    if clinical:
        check_patient_access(db, p, pt, view=view)
    return pt


def _plan_defaults(db: DbSession, patient_id: str) -> tuple[list[str], str]:
    plan = db.get(RecordingPlan, patient_id)
    if plan:
        return list(plan.tests), plan.med_state
    d = policy()["defaultPlan"]
    return list(d["tests"]), d["medState"]


def _doctor_name(db: DbSession, doctor_id: str | None) -> str | None:
    d = db.get(StaffUser, doctor_id) if doctor_id else None
    return (d.display_name or d.email) if d else None


def request_state(db: DbSession, r: RecordingRequest) -> str:
    """open → recorded (a session for it has an uploaded take); missed once past due; cancelled;
    not_recorded (a clinic request the operator could not record, with a reason)."""
    if r.status == "cancelled":
        return "cancelled"
    done = db.scalar(
        select(func.count())
        .select_from(Take)
        .join(Session, Session.id == Take.session_id)
        .where(Session.request_id == r.id, Take.status == "complete")
    )
    if done:
        return "recorded"
    if r.status == "not_done":
        return "not_recorded"
    if aware(r.due_at) < datetime.now(UTC):
        return "missed"
    return "open"


class RequestOut(BaseModel):
    id: str
    kind: str
    #: home = record link in the patient's app; clinic = the clinic phones' queue.
    place: str = "home"
    not_done_reason: str | None = None
    tests: list[str]
    #: v31 (decision 054): seconds per test the phone records each take for.
    durations: dict[str, float] = Field(default_factory=dict)
    med_state: str
    due_at: datetime
    remind: bool
    state: str
    created_at: datetime


def request_lengths(r: RecordingRequest) -> dict[str, float]:
    """Each of the request's tests and how long its take records (older requests: the config's)."""
    base = default_lengths()
    given = r.durations or {}
    return {t: float(given.get(t, base.get(t, 0))) for t in r.tests}


def _req_out(db: DbSession, r: RecordingRequest) -> RequestOut:
    return RequestOut(
        id=r.id,
        kind=r.kind,
        place=r.place,
        not_done_reason=r.not_done_reason,
        tests=list(r.tests),
        durations=request_lengths(r),
        med_state=r.med_state,
        due_at=r.due_at,
        remind=r.remind,
        state=request_state(db, r),
        created_at=r.created_at,
    )


class EventOut(BaseModel):
    """One step of an appointment's history, with the person who did it."""

    at: datetime
    action: str
    actor_name: str
    actor_email: str | None
    actor_role: str
    #: Safe details only (channel, tests, due date); doctor IDs come with their names.
    details: dict


class AppointmentOut(BaseModel):
    id: str
    ncid: str
    at: datetime
    doctor_id: str | None
    doctor_name: str | None
    source: str
    status: str
    #: Set for FHIR appointments: SHA-256 of the hospital's appointment ID (to match the live list).
    external_ref_hash: str | None
    #: needs_doctor → needs_tests (waiting for the doctor) → sent → recorded | missed; or cancelled.
    stage: str
    requests: list[RequestOut]
    #: Who added it by hand (null: it came from the hospital system).
    booked_by_name: str | None = None
    #: The latest step of its history (who did what, when).
    last_event: EventOut | None = None
    #: v13: the last move (from when, from which doctor, why) and an open patient change request.
    moved_at: datetime | None = None
    moved_from: datetime | None = None
    moved_from_doctor_name: str | None = None
    moved_reason: str | None = None
    change_request_id: str | None = None
    #: v14: cancelled by staff | patient, with a reason code.
    cancelled_by: str | None = None
    cancel_reason: str | None = None
    cancelled_at: datetime | None = None
    #: v14: the doctor changed before the patient recorded: the earlier tests, for the new doctor
    #: to confirm ({"tests", "med_state", "places", "from_doctor_name"}).
    suggested_tests: dict | None = None
    #: v14: an offer of times is with the patient: open | no_answer | call_requested.
    offer_state: str | None = None


def _appt_out(db: DbSession, a: Appointment, ncid: str) -> AppointmentOut:
    reqs = [
        _req_out(db, r)
        for r in db.scalars(
            select(RecordingRequest)
            .where(RecordingRequest.appointment_id == a.id)
            .order_by(RecordingRequest.created_at)
        )
    ]
    return AppointmentOut(
        id=a.id,
        ncid=ncid,
        at=a.at,
        doctor_id=a.doctor_id,
        doctor_name=_doctor_name(db, a.doctor_id),
        source=a.source,
        status=a.status,
        external_ref_hash=a.external_ref_hash,
        stage=appointment_stage(a, reqs),
        requests=reqs,
        booked_by_name=_staff_name(db, a.created_by) if a.source == "manual" else None,
        last_event=(appointment_events(db, a) or [None])[-1],
        moved_at=a.moved_at,
        moved_from=a.moved_from,
        moved_from_doctor_name=_doctor_name(db, a.moved_from_doctor_id),
        moved_reason=a.moved_reason,
        change_request_id=db.scalar(
            select(AppointmentChangeRequest.id).where(
                AppointmentChangeRequest.appointment_id == a.id, AppointmentChangeRequest.status == "open"
            )
        ),
        cancelled_by=a.cancelled_by,
        cancel_reason=a.cancel_reason,
        cancelled_at=a.cancelled_at,
        suggested_tests={
            **{k: v for k, v in a.suggested_tests.items() if k != "from_doctor"},
            "from_doctor_name": _doctor_name(db, a.suggested_tests.get("from_doctor")),
        }
        if a.suggested_tests
        else None,
        offer_state=_offer_state(db, a.id),
    )


def _offer_state(db: DbSession, appointment_id: str) -> str | None:
    o = db.scalar(
        select(AppointmentOffer)
        .where(
            AppointmentOffer.appointment_id == appointment_id,
            AppointmentOffer.status.in_(("open", "call_requested")),
        )
        .order_by(AppointmentOffer.created_at.desc())
        .limit(1)
    )
    if o is None:
        return None
    if o.status == "call_requested":
        return "call_requested"
    return "no_answer" if aware(o.reply_by) < datetime.now(UTC) else "open"


def _staff_name(db: DbSession, user_id: str | None) -> str | None:
    u = db.get(StaffUser, user_id) if user_id else None
    return (u.display_name or u.email) if u else None


#: Patient events that belong to an appointment's history.
PATIENT_ACTIONS = (
    "clinic_not_recorded",
    "patient_created",
    "patient_invited",
    "patient_reinvited",
    "patient_assigned",
    "patient_reassigned",
    "patient_unassigned",
    "recording_requested",
    "request_cancelled",
)
SAFE_DETAILS = (
    "channel",
    "source",
    "status",
    "tests",
    "kind",
    "med_state",
    "due",
    "via",
    "at",
    "place",
    "reason",
    "from",
    "days",
    "part_of_day",
    "answer",
    "by",
    "purpose",
    "options",
)


def appointment_events(db: DbSession, a: Appointment) -> list[EventOut]:
    """The appointment's own events plus what happened to its patient from 30 days before it was
    added (invites, doctor assignments, the record links sent for it)."""
    from app.people import People

    people = People(db)
    since = (aware(a.created_at) or datetime.now(UTC)) - timedelta(days=30)
    q = (
        select(AuditEvent)
        .where(
            AuditEvent.site_id == a.site_id,
            or_(
                and_(AuditEvent.target_type == "appointment", AuditEvent.target_id == a.id),
                and_(
                    AuditEvent.target_type == "patient",
                    AuditEvent.target_id == a.patient_id,
                    AuditEvent.action.in_(PATIENT_ACTIONS),
                    AuditEvent.at >= since,
                ),
            ),
        )
        .order_by(AuditEvent.at)
    )
    out = []
    for e in db.scalars(q):
        d = e.details or {}
        if e.action == "recording_requested" and d.get("appointment") not in (None, a.id):
            continue  # a link for another appointment
        details = {k: d[k] for k in SAFE_DETAILS if k in d}
        if d.get("doctor"):
            details["doctor_name"] = people.staff_name(d["doctor"]) or "—"
        if "previous" in d:
            details["previous_name"] = people.staff_name(d["previous"]) if d["previous"] else "—"
        who = people.who(e.actor_type, e.actor_id)
        out.append(
            EventOut(
                at=e.at,
                action=e.action,
                actor_name=who.name,
                actor_email=who.email,
                actor_role=who.role,
                details=details,
            )
        )
    return out


def appointment_stage(a: Appointment, reqs: list[RequestOut]) -> str:
    if a.status == "cancelled":
        return "cancelled"
    if a.doctor_id is None:
        return "needs_doctor"
    live = [r for r in reqs if r.state != "cancelled"]
    if not live:
        return "needs_tests"
    # Home and clinic may both be asked for: open beats recorded beats not recorded beats missed.
    for state, stage in (("open", "sent"), ("recorded", "recorded"), ("not_recorded", "not_recorded")):
        if any(r.state == state for r in live):
            return stage
    return "missed"


def external_hash(site_id: str, external_id: str) -> str:
    return sha256_hex(f"{site_id}:{external_id}")


@router.get("/hospital/appointments", response_model=list[AppointmentOut])
def list_appointments(
    days: int = Query(default=0, ge=0, le=60),
    past_days: int = Query(default=0, ge=0, le=60),
    p: Principal = Depends(can_view),
    db: DbSession = Depends(get_db),
) -> list[AppointmentOut]:
    """Appointments from yesterday to `days` ahead (default appointmentWindowDays), or the past
    `past_days` days (range picker, decision 038). Doctors see only their own appointments."""
    now_ = datetime.now(UTC)
    if past_days:
        start, end = now_ - timedelta(days=past_days), now_
    else:
        window = days or policy()["requests"]["appointmentWindowDays"]
        start, end = now_ - timedelta(days=1), now_ + timedelta(days=window)
    q = (
        select(Appointment, Patient.ncid)
        .join(Patient, Patient.id == Appointment.patient_id)
        .where(Appointment.site_id == p.site_id, Appointment.at >= start, Appointment.at <= end)
        .order_by(Appointment.at.desc() if past_days else Appointment.at)
    )
    if p.role == "doctor":
        q = q.where(Appointment.doctor_id == p.actor_id)
    return [_appt_out(db, a, ncid) for a, ncid in db.execute(q)]


class AppointmentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ncid: str = Field(pattern=r"^nc_[0-9a-f]{32}$")
    at: datetime
    doctor_id: str | None = None
    source: Literal["manual", "fhir"] = "manual"
    #: The hospital system's appointment ID (FHIR); hashed here, never stored as is.
    external_id: str | None = Field(default=None, max_length=128)


def _doctor_ok(db: DbSession, p: Principal, doctor_id: str | None) -> None:
    if doctor_id is None:
        return
    d = db.get(StaffUser, doctor_id)
    if not d or d.site_id != p.site_id or d.role != "doctor" or not d.active:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "not_a_doctor_here"})


@router.post("/hospital/appointments", response_model=AppointmentOut, status_code=201)
def create_appointment(body: AppointmentIn, p: Principal = Depends(can_add), db: DbSession = Depends(get_db)):
    pt = _patient(db, p, body.ncid, clinical=False)
    _doctor_ok(db, p, body.doctor_id)
    if body.doctor_id is not None and not allows(db, p, "appointments.assign"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "not_permitted"})
    ext = external_hash(p.site_id, body.external_id) if body.external_id else None
    if ext:
        existing = db.scalar(
            select(Appointment).where(Appointment.site_id == p.site_id, Appointment.external_ref_hash == ext)
        )
        if existing:
            # v13: a desk change is kept until the hospital system's own time changes again.
            new_at = aware(body.at)
            if existing.external_at is None or aware(existing.external_at) != new_at:
                if aware(existing.at) != new_at:
                    existing.at = new_at
                    audit(
                        db,
                        p.actor_type,
                        p.actor_id,
                        "appointment_changed",
                        "appointment",
                        existing.id,
                        site_id=p.site_id,
                        status=existing.status,
                        source="fhir",
                        at=new_at.isoformat(),
                    )
                existing.external_at = new_at
                db.commit()
            return _appt_out(db, existing, body.ncid)
    a = Appointment(
        site_id=p.site_id,
        patient_id=pt.id,
        at=body.at,
        doctor_id=body.doctor_id,
        source=body.source,
        external_ref_hash=ext,
        external_at=body.at if ext else None,
        created_by=p.actor_id,
    )
    db.add(a)
    db.flush()
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "appointment_added",
        "appointment",
        a.id,
        site_id=p.site_id,
        source=body.source,
        at=aware(a.at).isoformat(),
        doctor=body.doctor_id,
    )
    db.commit()
    return _appt_out(db, a, body.ncid)


class AppointmentPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    at: datetime | None = None
    doctor_id: str | None = None
    status: Literal["booked", "cancelled"] | None = None


def _appointment(db: DbSession, p: Principal, appt_id: str) -> tuple[Appointment, Patient]:
    a = db.get(Appointment, appt_id)
    pt = db.get(Patient, a.patient_id) if a else None
    if not a or not pt or a.site_id != p.site_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "appointment not found")
    return a, pt


@router.put("/hospital/appointments/{appt_id}", response_model=AppointmentOut)
def update_appointment(
    appt_id: str, body: AppointmentPatch, p: Principal = Depends(can_change), db: DbSession = Depends(get_db)
):
    a, pt = _appointment(db, p, appt_id)
    if body.doctor_id is not None and not allows(db, p, "appointments.assign"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "not_permitted"})
    if (body.at is not None or body.status is not None) and not allows(db, p, "appointments.add"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "not_permitted"})
    if body.status == "cancelled" and a.status != "cancelled":
        # v14: the same as "Cancel" with reason "other" (record links not yet recorded, requests
        # and offers are closed).
        from app.api.appointment_changes import cancel_appointment

        cancel_appointment(db, a, p.actor_type, p.actor_id, "staff", "other")
        db.commit()
        return _appt_out(db, a, pt.ncid)
    if body.at is not None and aware(body.at) != aware(a.at) and a.status != "cancelled":
        # v13: a date change moves its record links too (and closes an open patient request).
        from app.api.appointment_changes import apply_move

        apply_move(db, p, a, body.at, body.doctor_id, "other")
        body = body.model_copy(update={"at": None, "doctor_id": None})
    if body.doctor_id is not None and body.doctor_id != a.doctor_id:
        # Decision 038: only this appointment changes; the patient's other ones keep their doctors.
        _doctor_ok(db, p, body.doctor_id)
        audit(
            db,
            p.actor_type,
            p.actor_id,
            "appointment_doctor_changed",
            "appointment",
            a.id,
            site_id=p.site_id,
            at=aware(a.at).isoformat(),
            doctor=body.doctor_id,
            previous=a.doctor_id,
        )
        a.doctor_id = body.doctor_id
    if body.at is not None:
        a.at = body.at
    if body.status is not None:
        a.status = body.status
        if body.status == "booked":
            a.cancelled_by = a.cancel_reason = a.cancelled_at = None
    if body.at is not None or body.status is not None:  # a doctor change is logged on its own
        audit(
            db,
            p.actor_type,
            p.actor_id,
            "appointment_changed",
            "appointment",
            a.id,
            site_id=p.site_id,
            status=a.status,
            **({"at": aware(a.at).isoformat()} if body.at is not None else {}),
        )
    db.commit()
    return _appt_out(db, a, pt.ncid)


@router.get("/hospital/appointments/{appt_id}/history", response_model=list[EventOut])
def appointment_history(
    appt_id: str, p: Principal = Depends(can_view), db: DbSession = Depends(get_db)
) -> list[EventOut]:
    """Who did what for this appointment, oldest first (user, 16 Nov 2026)."""
    a, pt = _appointment(db, p, appt_id)
    _patient(db, p, pt.ncid, view=True)  # doctors: their patients (view-only after a move too)
    return appointment_events(db, a)


class RequestIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: Empty = the doctor's plan (or the hospital default).
    tests: list[TestCode] = Field(default_factory=list, max_length=5)
    med_state: Literal["OFF", "ON", "ANY"] | None = None
    #: Default: the appointment minus requests.defaultDueDaysBefore days.
    due_at: datetime | None = None
    remind: bool = True
    #: Doctor only: also record at home every N days until the next appointment (periodic plan).
    repeat_every_days: int | None = Field(default=None, ge=1, le=90)
    #: Where to record (user, 16 Nov 2026): at home (record link), in the clinic (operator
    #: queue), or both.
    places: list[Literal["home", "clinic"]] = Field(
        default_factory=lambda: ["home"], min_length=1, max_length=2
    )
    #: v31 (decision 054): the doctor's lengths for this request, {test: seconds}; tests not
    #: given use the hospital's lengths (Settings).
    durations: dict[TestCode, float] | None = None


def _new_request(
    db: DbSession,
    p: Principal,
    pt: Patient,
    body: RequestIn,
    *,
    kind: str,
    appointment: Appointment | None,
    default_due: datetime,
    place: str = "home",
) -> RecordingRequest:
    if place == "home":
        acc = db.scalar(select(PatientAccount).where(PatientAccount.patient_id == pt.id))
        if not acc or acc.status != "active":
            raise HTTPException(status.HTTP_409_CONFLICT, {"code": "not_joined"})
    tests, med = _plan_defaults(db, pt.id)
    if body.tests:
        tests = [t for t in ORDER if t in body.tests]
    if body.durations and (bad := offered(body.durations)):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "duration_not_offered", "test": bad}
        )
    hospital = site_settings(db.get(Site, pt.site_id))["test_durations"]
    lengths = {t: float((body.durations or {}).get(t, hospital.get(t, 0))) for t in tests}
    r = RecordingRequest(
        site_id=pt.site_id,
        patient_id=pt.id,
        appointment_id=appointment.id if appointment else None,
        kind=kind,
        tests=tests,
        durations=lengths,
        med_state=body.med_state or med,
        due_at=body.due_at or default_due if place == "home" else default_due,
        remind=body.remind and place == "home",  # the connector reminds for home links only
        place=place,
        created_by=p.actor_id,
    )
    db.add(r)
    db.flush()
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "recording_requested",
        "patient",
        pt.id,
        site_id=p.site_id,
        kind=kind,
        place=place,
        tests=tests,
        durations=lengths,
        med_state=r.med_state,
        due=aware(r.due_at).date().isoformat(),
        appointment=appointment.id if appointment else None,
    )
    return r


def _set_periodic(db: DbSession, p: Principal, pt: Patient, tests: list[str], med: str, days: int) -> None:
    """The doctor asked for recordings every `days` days as well (v3: only when asked), until the
    patient's next appointment from now."""
    plan = db.get(RecordingPlan, pt.id)
    if plan is None:
        plan = RecordingPlan(patient_id=pt.id)
        db.add(plan)
    plan.tests, plan.med_state, plan.every_days, plan.periodic = tests, med, days, True
    plan.updated_by, plan.updated_at = p.actor_id, datetime.now(UTC)
    plan.periodic_since = plan.updated_at
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "plan_changed",
        "patient",
        pt.id,
        site_id=p.site_id,
        periodic=True,
        every_days=days,
    )


@router.post("/hospital/appointments/{appt_id}/request", response_model=list[RequestOut], status_code=201)
def request_for_appointment(
    appt_id: str, body: RequestIn, p: Principal = Depends(can_send), db: DbSession = Depends(get_db)
):
    """The assigned doctor chooses the tests and sends the patient the record link."""
    a, pt = _appointment(db, p, appt_id)
    _patient(db, p, pt.ncid)  # the doctor must be assigned to this patient
    if a.doctor_id != p.actor_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "not_your_appointment"})
    if a.status == "cancelled":
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "appointment_cancelled"})
    home_due = aware(a.at) - timedelta(days=policy()["requests"]["defaultDueDaysBefore"])
    clinic_due = aware(a.at) + timedelta(hours=12)  # recorded at the visit, that day
    made = [
        _new_request(
            db,
            p,
            pt,
            body,
            kind="appointment",
            appointment=a,
            default_due=home_due if place == "home" else clinic_due,
            place=place,
        )
        for place in _places(body)
    ]
    if body.repeat_every_days and "home" in body.places:
        _set_periodic(db, p, pt, list(made[0].tests), made[0].med_state, body.repeat_every_days)
    a.suggested_tests = None  # v14: the (new) doctor confirmed the tests
    db.commit()
    return [_req_out(db, r) for r in made]


def _places(body: "RequestIn") -> list[str]:
    """Home first, then clinic; each once."""
    return [x for x in ("home", "clinic") if x in body.places]


@router.post("/hospital/patients/{ncid}/rerecord", response_model=list[RequestOut], status_code=201)
def rerecord(
    ncid: str,
    body: RequestIn,
    p: Principal = Depends(can_rerecord),
    db: DbSession = Depends(get_db),
):
    """The doctor asks to record again (all of the plan, or some tests)."""
    pt = _patient(db, p, ncid)
    due = datetime.now(UTC) + timedelta(days=policy()["requests"]["rerecordDueDays"])
    made = [
        _new_request(db, p, pt, body, kind="rerecord", appointment=None, default_due=due, place=place)
        for place in _places(body)
    ]
    if body.repeat_every_days and "home" in body.places:
        _set_periodic(db, p, pt, list(made[0].tests), made[0].med_state, body.repeat_every_days)
    db.commit()
    return [_req_out(db, r) for r in made]


@router.post("/hospital/requests/{req_id}/cancel", response_model=RequestOut)
def cancel_request(req_id: str, p: Principal = Depends(can_view_or_send), db: DbSession = Depends(get_db)):
    r = db.get(RecordingRequest, req_id)
    pt = db.get(Patient, r.patient_id) if r else None
    if not r or not pt or r.site_id != p.site_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "request not found")
    _patient(db, p, pt.ncid)
    r.status = "cancelled"
    audit(db, p.actor_type, p.actor_id, "request_cancelled", "patient", pt.id, site_id=p.site_id)
    db.commit()
    return _req_out(db, r)


# --- History (dashboard) ---


class SessionRow(BaseModel):
    id: str
    started_at: datetime
    recorded_by: str
    med_state: str
    request_id: str | None
    takes_uploaded: int
    #: v16: patient_app | clinic_phone (with a reason) for clinic recordings.
    consent_source: str | None = None
    consent_reason: str | None = None


class HistoryOut(BaseModel):
    ncid: str
    app_status: str
    withdrawn_at: datetime | None
    #: Decision 061: for a doctor who may only view (their appointment moved to another doctor).
    view_only: bool = False
    moved_to: str | None = None
    appointments: list[AppointmentOut]
    other_requests: list[RequestOut]
    sessions: list[SessionRow]


@router.get("/hospital/patients/{ncid}/history", response_model=HistoryOut)
def history(
    ncid: str, p: Principal = Depends(can_view_or_send), db: DbSession = Depends(get_db)
) -> HistoryOut:
    """Appointments, requests and sessions. All of it stays with the hospital after a withdrawal."""
    pt = _patient(db, p, ncid, view=True)
    acc = db.scalar(select(PatientAccount).where(PatientAccount.patient_id == pt.id))
    appts = db.scalars(
        select(Appointment).where(Appointment.patient_id == pt.id).order_by(Appointment.at.desc())
    )
    others = db.scalars(
        select(RecordingRequest)
        .where(RecordingRequest.patient_id == pt.id, RecordingRequest.appointment_id.is_(None))
        .order_by(RecordingRequest.created_at.desc())
    )
    done = (
        select(Take.session_id, func.count().label("n"))
        .where(Take.status == "complete")
        .group_by(Take.session_id)
        .subquery()
    )
    sessions = db.execute(
        select(Session, done.c.n)
        .outerjoin(done, done.c.session_id == Session.id)
        .where(Session.patient_id == pt.id)
        .order_by(Session.started_at.desc())
    )
    from app.assignments import doctor_view_only_ids, moved_to_names

    view_only = p.role == "doctor" and pt.id in doctor_view_only_ids(db, p.actor_id)
    return HistoryOut(
        ncid=ncid,
        view_only=view_only,
        moved_to=moved_to_names(db, p.actor_id, {pt.id}).get(pt.id) if view_only else None,
        app_status=acc.status if acc else "clinic",
        withdrawn_at=acc.withdrawn_at if acc else None,
        appointments=[_appt_out(db, a, ncid) for a in appts],
        other_requests=[_req_out(db, r) for r in others],
        sessions=[
            SessionRow(
                id=s.id,
                started_at=s.started_at,
                recorded_by=s.recorded_by,
                med_state=s.med_state,
                request_id=s.request_id,
                takes_uploaded=n or 0,
                consent_source=s.consent_source,
                consent_reason=s.consent_reason,
            )
            for s, n in sessions
        ],
    )


# --- The patient's app ---


class PatientRequest(BaseModel):
    id: str
    kind: str
    #: clinic = recorded at the visit by the clinic (shown as information, no record button).
    place: str = "home"
    appointment_at: datetime | None
    doctor_name: str | None
    tests: list[str]
    #: v31: seconds per test (the phone's native timer stops each take there).
    durations: dict[str, float] = Field(default_factory=dict)
    med_state: str
    due_at: datetime
    state: str
    #: v16: clinic requests: the patient's consent in the app (active | used | null) and until when.
    clinic_consent: dict | None = None


@router.get("/patient/requests", response_model=list[PatientRequest])
def patient_requests(
    p: Principal = Depends(current_principal), db: DbSession = Depends(get_db)
) -> list[PatientRequest]:
    """This hospital's requests for the signed-in patient, newest first (open ones and history)."""
    if p.patient is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "patient sign-in required")
    q = (
        select(RecordingRequest, Appointment)
        .outerjoin(Appointment, Appointment.id == RecordingRequest.appointment_id)
        .where(RecordingRequest.patient_id == p.patient.patient_id)
        .order_by(RecordingRequest.created_at.desc())
        .limit(100)
    )
    out = []
    for r, a in db.execute(q):
        doctor = a.doctor_id if a else r.created_by if r.kind == "rerecord" else None
        out.append(
            PatientRequest(
                id=r.id,
                kind=r.kind,
                place=r.place,
                appointment_at=a.at if a else None,
                doctor_name=_doctor_name(db, doctor),
                tests=list(r.tests),
                durations=request_lengths(r),
                med_state=r.med_state,
                due_at=r.due_at,
                state=request_state(db, r),
                clinic_consent=_patient_consent(db, r) if r.place == "clinic" else None,
            )
        )
    return out


def _patient_consent(db: DbSession, r: RecordingRequest) -> dict | None:
    from app.models import ClinicConsent

    c = db.scalar(
        select(ClinicConsent)
        .where(ClinicConsent.request_id == r.id, ClinicConsent.status.in_(("active", "used")))
        .order_by(ClinicConsent.agreed_at.desc())
        .limit(1)
    )
    if not c:
        return None
    return {"status": c.status, "source": c.source, "valid_until": aware(c.valid_until).isoformat()}


# --- Reminders (sent by the hospital connector, which holds the contact details) ---


class ReminderOut(BaseModel):
    request_id: str
    ncid: str
    due_at: datetime
    appointment_at: datetime | None
    tests: list[str]


@router.get("/connector/v1/reminders/due", response_model=list[ReminderOut])
def reminders_due(
    site: Site = Depends(signed_connector), db: DbSession = Depends(get_db)
) -> list[ReminderOut]:
    lead = timedelta(hours=policy()["requests"]["reminderHoursBefore"])
    now_ = datetime.now(UTC)
    q = (
        select(RecordingRequest, Patient.ncid, Appointment.at)
        .join(Patient, Patient.id == RecordingRequest.patient_id)
        .join(PatientAccount, PatientAccount.patient_id == Patient.id)
        .outerjoin(Appointment, Appointment.id == RecordingRequest.appointment_id)
        .where(
            RecordingRequest.site_id == site.id,
            RecordingRequest.status == "open",
            RecordingRequest.remind.is_(True),
            RecordingRequest.place == "home",
            RecordingRequest.reminder_sent_at.is_(None),
            PatientAccount.status == "active",
        )
    )
    out = []
    for r, ncid, appt_at in db.execute(q):
        due = aware(r.due_at)
        if due - lead <= now_ < due and request_state(db, r) == "open":
            out.append(
                ReminderOut(
                    request_id=r.id, ncid=ncid, due_at=due, appointment_at=appt_at, tests=list(r.tests)
                )
            )
    return out


@router.post("/connector/v1/reminders/{req_id}/sent", status_code=204)
def reminder_sent(
    req_id: str, site: Site = Depends(signed_connector), db: DbSession = Depends(get_db)
) -> None:
    r = db.get(RecordingRequest, req_id)
    if not r or r.site_id != site.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "request not found")
    r.reminder_sent_at = datetime.now(UTC)
    audit(db, "connector", site.id, "reminder_sent", "patient", r.patient_id, site_id=site.id)
    db.commit()
