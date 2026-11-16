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
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from app.api.connector_link import signed_connector
from app.audit import audit
from app.db import get_db
from app.models import (
    Appointment,
    Patient,
    PatientAccount,
    PatientAssignment,
    RecordingPlan,
    RecordingRequest,
    Session,
    Site,
    StaffUser,
    Take,
)
from app.policy import policy
from app.security import Principal, current_principal, require_role, sha256_hex

router = APIRouter(tags=["appointments"])
desk = require_role("receptionist", "hospital_admin")
doctor_only = require_role("doctor")
staff = require_role("receptionist", "hospital_admin", "doctor")

TestCode = Literal["FT", "FTF", "FR", "SAW", "FA"]
ORDER = ["FT", "FTF", "FR", "SAW", "FA"]


def aware(dt: datetime | None) -> datetime | None:
    return dt if dt is None or dt.tzinfo else dt.replace(tzinfo=UTC)


def _patient(db: DbSession, p: Principal, ncid: str) -> Patient:
    from app.assignments import check_patient_access

    pt = db.scalar(select(Patient).where(Patient.ncid == ncid, Patient.site_id == p.site_id))
    if not pt:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient not found")
    check_patient_access(db, p, pt)
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
    """open → recorded (a session for it has an uploaded take); expired once past due; cancelled."""
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
    if aware(r.due_at) < datetime.now(UTC):
        return "missed"
    return "open"


class RequestOut(BaseModel):
    id: str
    kind: str
    tests: list[str]
    med_state: str
    due_at: datetime
    remind: bool
    state: str
    created_at: datetime


def _req_out(db: DbSession, r: RecordingRequest) -> RequestOut:
    return RequestOut(
        id=r.id,
        kind=r.kind,
        tests=list(r.tests),
        med_state=r.med_state,
        due_at=r.due_at,
        remind=r.remind,
        state=request_state(db, r),
        created_at=r.created_at,
    )


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
    )


def appointment_stage(a: Appointment, reqs: list[RequestOut]) -> str:
    if a.status == "cancelled":
        return "cancelled"
    if a.doctor_id is None:
        return "needs_doctor"
    live = [r for r in reqs if r.state != "cancelled"]
    if not live:
        return "needs_tests"
    last = live[-1].state
    return {"open": "sent"}.get(last, last)  # recorded | missed


def external_hash(site_id: str, external_id: str) -> str:
    return sha256_hex(f"{site_id}:{external_id}")


@router.get("/hospital/appointments", response_model=list[AppointmentOut])
def list_appointments(
    days: int = Query(default=0, ge=0, le=60),
    p: Principal = Depends(staff),
    db: DbSession = Depends(get_db),
) -> list[AppointmentOut]:
    """Appointments known here, from yesterday to `days` ahead (default: appointmentWindowDays).
    Doctors see only their own patients' appointments."""
    window = days or policy()["requests"]["appointmentWindowDays"]
    now_ = datetime.now(UTC)
    q = (
        select(Appointment, Patient.ncid)
        .join(Patient, Patient.id == Appointment.patient_id)
        .where(
            Appointment.site_id == p.site_id,
            Appointment.at >= now_ - timedelta(days=1),
            Appointment.at <= now_ + timedelta(days=window),
        )
        .order_by(Appointment.at)
    )
    if p.role == "doctor":
        q = q.join(PatientAssignment, PatientAssignment.patient_id == Patient.id).where(
            PatientAssignment.doctor_id == p.actor_id
        )
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


def _assign(db: DbSession, p: Principal, patient: Patient, doctor_id: str | None) -> None:
    """Booking with a doctor also assigns the patient to that doctor (they must see the recordings)."""
    if doctor_id is None:
        return
    from app.assignments import follow_assignment

    a = db.get(PatientAssignment, patient.id)
    if a and a.doctor_id == doctor_id:
        follow_assignment(db, patient.id, doctor_id)  # the patient's other upcoming ones too
        return
    if a:
        a.doctor_id, a.assigned_by, a.assigned_at = doctor_id, p.actor_id, datetime.now(UTC)
    else:
        db.add(
            PatientAssignment(
                patient_id=patient.id,
                doctor_id=doctor_id,
                assigned_by=p.actor_id,
                assigned_at=datetime.now(UTC),
            )
        )
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "patient_assigned",
        "patient",
        patient.id,
        site_id=p.site_id,
        doctor=doctor_id,
        via="appointment",
        appointments_moved=follow_assignment(db, patient.id, doctor_id),
    )


@router.post("/hospital/appointments", response_model=AppointmentOut, status_code=201)
def create_appointment(body: AppointmentIn, p: Principal = Depends(desk), db: DbSession = Depends(get_db)):
    pt = _patient(db, p, body.ncid)
    _doctor_ok(db, p, body.doctor_id)
    ext = external_hash(p.site_id, body.external_id) if body.external_id else None
    if ext:
        existing = db.scalar(
            select(Appointment).where(Appointment.site_id == p.site_id, Appointment.external_ref_hash == ext)
        )
        if existing:
            return _appt_out(db, existing, body.ncid)
    a = Appointment(
        site_id=p.site_id,
        patient_id=pt.id,
        at=body.at,
        doctor_id=body.doctor_id,
        source=body.source,
        external_ref_hash=ext,
        created_by=p.actor_id,
    )
    db.add(a)
    _assign(db, p, pt, body.doctor_id)
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
    appt_id: str, body: AppointmentPatch, p: Principal = Depends(desk), db: DbSession = Depends(get_db)
):
    a, pt = _appointment(db, p, appt_id)
    if body.doctor_id is not None:
        _doctor_ok(db, p, body.doctor_id)
        a.doctor_id = body.doctor_id
        _assign(db, p, pt, body.doctor_id)
    if body.at is not None:
        a.at = body.at
    if body.status is not None:
        a.status = body.status
        if body.status == "cancelled":
            for r in db.scalars(select(RecordingRequest).where(RecordingRequest.appointment_id == a.id)):
                r.status = "cancelled"
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "appointment_changed",
        "appointment",
        a.id,
        site_id=p.site_id,
        status=a.status,
    )
    db.commit()
    return _appt_out(db, a, pt.ncid)


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


def _new_request(
    db: DbSession,
    p: Principal,
    pt: Patient,
    body: RequestIn,
    *,
    kind: str,
    appointment: Appointment | None,
    default_due: datetime,
) -> RecordingRequest:
    acc = db.scalar(select(PatientAccount).where(PatientAccount.patient_id == pt.id))
    if not acc or acc.status != "active":
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "not_joined"})
    tests, med = _plan_defaults(db, pt.id)
    if body.tests:
        tests = [t for t in ORDER if t in body.tests]
    r = RecordingRequest(
        site_id=pt.site_id,
        patient_id=pt.id,
        appointment_id=appointment.id if appointment else None,
        kind=kind,
        tests=tests,
        med_state=body.med_state or med,
        due_at=body.due_at or default_due,
        remind=body.remind,
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
        tests=tests,
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


@router.post("/hospital/appointments/{appt_id}/request", response_model=RequestOut, status_code=201)
def request_for_appointment(
    appt_id: str, body: RequestIn, p: Principal = Depends(doctor_only), db: DbSession = Depends(get_db)
):
    """The assigned doctor chooses the tests and sends the patient the record link."""
    a, pt = _appointment(db, p, appt_id)
    _patient(db, p, pt.ncid)  # the doctor must be assigned to this patient
    if a.doctor_id != p.actor_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, {"code": "not_your_appointment"})
    if a.status == "cancelled":
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "appointment_cancelled"})
    due = aware(a.at) - timedelta(days=policy()["requests"]["defaultDueDaysBefore"])
    r = _new_request(db, p, pt, body, kind="appointment", appointment=a, default_due=due)
    if body.repeat_every_days:
        _set_periodic(db, p, pt, list(r.tests), r.med_state, body.repeat_every_days)
    db.commit()
    return _req_out(db, r)


@router.post("/hospital/patients/{ncid}/rerecord", response_model=RequestOut, status_code=201)
def rerecord(
    ncid: str,
    body: RequestIn,
    p: Principal = Depends(doctor_only),
    db: DbSession = Depends(get_db),
):
    """The doctor asks to record again (all of the plan, or some tests)."""
    pt = _patient(db, p, ncid)
    due = datetime.now(UTC) + timedelta(days=policy()["requests"]["rerecordDueDays"])
    r = _new_request(db, p, pt, body, kind="rerecord", appointment=None, default_due=due)
    if body.repeat_every_days:
        _set_periodic(db, p, pt, list(r.tests), r.med_state, body.repeat_every_days)
    db.commit()
    return _req_out(db, r)


@router.post("/hospital/requests/{req_id}/cancel", response_model=RequestOut)
def cancel_request(req_id: str, p: Principal = Depends(staff), db: DbSession = Depends(get_db)):
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


class HistoryOut(BaseModel):
    ncid: str
    app_status: str
    withdrawn_at: datetime | None
    appointments: list[AppointmentOut]
    other_requests: list[RequestOut]
    sessions: list[SessionRow]


@router.get("/hospital/patients/{ncid}/history", response_model=HistoryOut)
def history(ncid: str, p: Principal = Depends(staff), db: DbSession = Depends(get_db)) -> HistoryOut:
    """Appointments, requests and sessions. All of it stays with the hospital after a withdrawal."""
    pt = _patient(db, p, ncid)
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
    return HistoryOut(
        ncid=ncid,
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
            )
            for s, n in sessions
        ],
    )


# --- The patient's app ---


class PatientRequest(BaseModel):
    id: str
    kind: str
    appointment_at: datetime | None
    doctor_name: str | None
    tests: list[str]
    med_state: str
    due_at: datetime
    state: str


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
                appointment_at=a.at if a else None,
                doctor_name=_doctor_name(db, doctor),
                tests=list(r.tests),
                med_state=r.med_state,
                due_at=r.due_at,
                state=request_state(db, r),
            )
        )
    return out


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
