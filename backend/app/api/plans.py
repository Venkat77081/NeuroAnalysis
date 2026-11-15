"""Recording plans, patient history and consent withdrawal (PLATFORM_PLAN M13)."""

from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from app.audit import audit
from app.db import get_db
from app.models import (
    DeletionRequest,
    Device,
    Patient,
    PatientAccount,
    PatientRefreshToken,
    RecordingPlan,
    Session,
    Site,
    Take,
)
from app.policy import policy
from app.security import Principal, current_principal, require_role

router = APIRouter(tags=["plans"])

TestCode = Literal["FT", "FTF", "FR", "SAW", "FA"]


class PlanIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tests: list[TestCode] = Field(min_length=1, max_length=5)
    every_days: int = Field(ge=1, le=90)
    med_state: Literal["OFF", "ON", "ANY"]


class PlanOut(BaseModel):
    tests: list[str]
    every_days: int
    med_state: str
    #: True: the hospital's default (config/platform.json), not set by a doctor yet.
    default: bool
    updated_at: datetime | None = None
    #: M14: the doctor's re-record request, if any (tests asked for again).
    rerecord_requested_at: datetime | None = None
    rerecord_tests: list[str] | None = None


def plan_for(db: DbSession, patient_id: str) -> PlanOut:
    plan = db.get(RecordingPlan, patient_id)
    if plan:
        return PlanOut(
            tests=list(plan.tests),
            every_days=plan.every_days,
            med_state=plan.med_state,
            default=plan.updated_by == "default",
            updated_at=plan.updated_at,
            rerecord_requested_at=plan.rerecord_requested_at,
            rerecord_tests=list(plan.rerecord_tests) if plan.rerecord_tests else None,
        )
    d = policy()["defaultPlan"]
    return PlanOut(tests=list(d["tests"]), every_days=d["everyDays"], med_state=d["medState"], default=True)


def _patient(db: DbSession, p: Principal, ncid: str) -> Patient:
    pt = db.scalar(select(Patient).where(Patient.ncid == ncid, Patient.site_id == p.site_id))
    if not pt:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "patient not found")
    return pt


staff_reader = require_role("doctor", "hospital_admin")


@router.get("/hospital/patients/{ncid}/plan", response_model=PlanOut)
def get_plan(ncid: str, p: Principal = Depends(staff_reader), db: DbSession = Depends(get_db)) -> PlanOut:  # noqa: B008
    return plan_for(db, _patient(db, p, ncid).id)


@router.put("/hospital/patients/{ncid}/plan", response_model=PlanOut)
def set_plan(
    ncid: str,
    body: PlanIn,
    p: Principal = Depends(staff_reader),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> PlanOut:
    pt = _patient(db, p, ncid)
    tests = list(dict.fromkeys(body.tests))
    plan = db.get(RecordingPlan, pt.id) or RecordingPlan(patient_id=pt.id)
    plan.tests, plan.every_days, plan.med_state = tests, body.every_days, body.med_state
    plan.updated_by, plan.updated_at = p.actor_id, datetime.now(UTC)
    db.add(plan)
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "plan_set",
        "patient",
        pt.id,
        site_id=p.site_id,
        tests=tests,
        every_days=body.every_days,
        med_state=body.med_state,
    )
    db.commit()
    return plan_for(db, pt.id)


class RerecordIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: Tests to record again; empty = the whole plan.
    tests: list[TestCode] = Field(default_factory=list, max_length=5)


@router.post("/hospital/patients/{ncid}/rerecord", response_model=PlanOut)
def rerecord(
    ncid: str,
    body: RerecordIn,
    p: Principal = Depends(require_role("doctor")),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> PlanOut:
    """The doctor asks for a new recording: the patient's app shows it due now."""
    pt = _patient(db, p, ncid)
    plan = db.get(RecordingPlan, pt.id)
    if plan is None:
        d = policy()["defaultPlan"]
        plan = RecordingPlan(
            patient_id=pt.id,
            tests=list(d["tests"]),
            every_days=d["everyDays"],
            med_state=d["medState"],
            updated_by="default",
            updated_at=datetime.now(UTC),
        )
        db.add(plan)
    plan.rerecord_requested_at = datetime.now(UTC)
    plan.rerecord_tests = list(dict.fromkeys(body.tests)) or None
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "rerecord_requested",
        "patient",
        pt.id,
        site_id=p.site_id,
        tests=plan.rerecord_tests,
    )
    db.commit()
    return plan_for(db, pt.id)


def _me(p: Principal) -> PatientAccount:
    if p.patient is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "patient sign-in required")
    return p.patient


class PatientPlanOut(PlanOut):
    last_session_at: datetime | None
    next_due: datetime | None
    #: True when no session yet, the interval has passed, or the doctor asked to record again.
    due_now: bool
    #: True while a re-record request is open (tests: the ones asked for).
    rerecord: bool = False


@router.get("/patient/plan", response_model=PatientPlanOut)
def patient_plan(
    p: Principal = Depends(current_principal), db: DbSession = Depends(get_db)
) -> PatientPlanOut:  # noqa: B008
    acc = _me(p)
    plan = plan_for(db, acc.patient_id)
    last = db.scalar(
        select(func.max(Session.started_at)).where(
            Session.patient_id == acc.patient_id, Session.recorded_by == "patient"
        )
    )
    if last is not None and last.tzinfo is None:
        last = last.replace(tzinfo=UTC)
    nxt = last + timedelta(days=plan.every_days) if last else None
    req = plan.rerecord_requested_at
    if req is not None and req.tzinfo is None:
        req = req.replace(tzinfo=UTC)
    # A re-record request stays open until the patient records again.
    rerecord = req is not None and (last is None or last < req)
    out = plan.model_dump()
    if rerecord and plan.rerecord_tests:
        out["tests"] = [t for t in plan.tests if t in plan.rerecord_tests] or list(plan.rerecord_tests)
    return PatientPlanOut(
        **out,
        last_session_at=last,
        next_due=nxt,
        due_now=rerecord or nxt is None or nxt <= datetime.now(UTC),
        rerecord=rerecord,
    )


class PatientSessionOut(BaseModel):
    id: str
    client_session_id: str
    started_at: datetime
    ended_at: datetime | None
    med_state: str
    recorded_by: str
    takes_uploaded: int


@router.get("/patient/sessions", response_model=list[PatientSessionOut])
def patient_sessions(
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> list[PatientSessionOut]:
    """The patient's own sessions (home and clinic), newest first. No other patient is visible."""
    acc = _me(p)
    done = (
        select(Take.session_id, func.count().label("n"))
        .where(Take.status == "complete")
        .group_by(Take.session_id)
        .subquery()
    )
    q = (
        select(Session, done.c.n)
        .outerjoin(done, done.c.session_id == Session.id)
        .where(Session.patient_id == acc.patient_id)
        .order_by(Session.started_at.desc())
        .limit(100)
    )
    return [
        PatientSessionOut(
            id=s.id,
            client_session_id=s.client_session_id,
            started_at=s.started_at,
            ended_at=s.ended_at,
            med_state=s.med_state,
            recorded_by=s.recorded_by,
            takes_uploaded=n or 0,
        )
        for s, n in db.execute(q)
    ]


class WithdrawIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    #: Also ask the hospital to delete the recordings already made.
    delete_recordings: bool


class WithdrawOut(BaseModel):
    status: str
    deletion_request_id: str | None


@router.post("/patient/consent/withdraw", response_model=WithdrawOut)
def withdraw(
    body: WithdrawIn,
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> WithdrawOut:
    """Stops home recording at once: the account closes and this phone is signed out for good."""
    acc = _me(p)
    acc.status = "closed"
    acc.invite_token_hash = None
    if acc.device_id:
        dev = db.get(Device, acc.device_id)
        if dev and dev.revoked_at is None:
            dev.revoked_at = datetime.now(UTC)
    for rt in db.scalars(select(PatientRefreshToken).where(PatientRefreshToken.account_id == acc.id)):
        rt.revoked = True
    req = None
    if body.delete_recordings:
        req = DeletionRequest(site_id=acc.site_id, patient_id=acc.patient_id)
        db.add(req)
        db.flush()
    audit(
        db,
        "patient",
        acc.id,
        "consent_withdrawn",
        "patient",
        acc.patient_id,
        site_id=acc.site_id,
        delete_recordings=body.delete_recordings,
    )
    db.commit()
    _tell_hospital(db, acc, body.delete_recordings)
    return WithdrawOut(status="closed", deletion_request_id=req.id if req else None)


def _tell_hospital(db: DbSession, acc: PatientAccount, delete: bool) -> None:
    """Best effort: log it in the hospital's activity log too (the dashboard also lists requests)."""
    import httpx

    from app.api.connector_link import call_connector

    site = db.get(Site, acc.site_id)
    patient = db.get(Patient, acc.patient_id)
    if not site or not patient or not site.connector_url:
        return
    action = "deletion_requested" if delete else "consent_withdrawn"
    try:
        call_connector(
            site,
            "POST",
            "/v1/activity",
            {"actor_type": "patient", "actor_id": acc.id, "action": action, "ncid": patient.ncid},
        )
    except (httpx.HTTPError, HTTPException):
        pass


class DeletionOut(BaseModel):
    id: str
    ncid: str
    requested_at: datetime
    status: str
    done_at: datetime | None


@router.get("/hospital/deletion-requests", response_model=list[DeletionOut])
def deletion_requests(
    p: Principal = Depends(require_role("hospital_admin")),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> list[DeletionOut]:
    q = (
        select(DeletionRequest, Patient.ncid)
        .join(Patient, Patient.id == DeletionRequest.patient_id)
        .where(DeletionRequest.site_id == p.site_id)
        .order_by(DeletionRequest.requested_at.desc())
    )
    return [
        DeletionOut(id=r.id, ncid=ncid, requested_at=r.requested_at, status=r.status, done_at=r.done_at)
        for r, ncid in db.execute(q)
    ]


@router.post("/hospital/deletion-requests/{req_id}/done", response_model=DeletionOut)
def deletion_done(
    req_id: str,
    p: Principal = Depends(require_role("hospital_admin")),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> DeletionOut:
    """The hospital deleted the recordings in its storage. The platform then removes its own records
    of those takes (quality data, file entries); the NCID and the audit trail stay."""
    from app.models import BiomarkerRun, TakeFile

    r = db.get(DeletionRequest, req_id)
    if not r or r.site_id != p.site_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "request not found")
    if r.status != "done":
        take_ids = [
            t.id
            for t in db.scalars(
                select(Take)
                .join(Session, Session.id == Take.session_id)
                .where(Session.patient_id == r.patient_id)
            )
        ]
        for model in (BiomarkerRun, TakeFile):
            for row in db.scalars(select(model).where(model.take_id.in_(take_ids))):
                db.delete(row)
        for t in db.scalars(select(Take).where(Take.id.in_(take_ids))):
            db.delete(t)
        r.status, r.done_at, r.done_by = "done", datetime.now(UTC), p.actor_id
        audit(
            db,
            p.actor_type,
            p.actor_id,
            "recordings_deleted",
            "patient",
            r.patient_id,
            site_id=p.site_id,
            takes=len(take_ids),
        )
        db.commit()
    ncid = db.get(Patient, r.patient_id).ncid
    return DeletionOut(id=r.id, ncid=ncid, requested_at=r.requested_at, status=r.status, done_at=r.done_at)
