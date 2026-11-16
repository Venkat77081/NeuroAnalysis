"""Clinic queue (user, 16 Nov 2026): recording requests the doctor sent "in the clinic" appear on
the hospital's clinic phones for the visit day. The phone shows names and MRNs read live from the
hospital connector; the platform sends NCIDs only."""

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.api.requests import _staff_name, aware, request_state
from app.audit import audit
from app.db import get_db
from app.models import Appointment, Operator, Patient, RecordingRequest, Session
from app.permissions import require
from app.policy import policy
from app.security import Principal

router = APIRouter(prefix="/clinic", tags=["clinic"])
operator_queue = require("clinic.record")


class QueueItem(BaseModel):
    request_id: str
    ncid: str
    #: The visit (or, for a record-again request without an appointment, its due time).
    at: datetime
    doctor_name: str | None
    tests: list[str]
    med_state: str
    #: open | recorded | not_recorded | missed
    state: str
    recorded_by: str | None
    not_done_reason: str | None


def _when(db: DbSession, r: RecordingRequest) -> datetime:
    a = db.get(Appointment, r.appointment_id) if r.appointment_id else None
    return aware(a.at) if a else aware(r.due_at)


@router.get("/queue", response_model=list[QueueItem])
def queue(
    start: datetime = Query(alias="from"),
    end: datetime = Query(alias="to"),
    p: Principal = Depends(operator_queue),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> list[QueueItem]:
    """Clinic requests of this hospital between `from` and `to` (the phone sends its own day, with
    its time zone)."""
    start, end = aware(start), aware(end)
    if end <= start or end - start > timedelta(hours=policy()["requests"]["clinicQueueMaxHours"]):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "bad_window"})
    rows = db.execute(
        select(RecordingRequest, Patient.ncid)
        .join(Patient, Patient.id == RecordingRequest.patient_id)
        .where(
            RecordingRequest.site_id == p.site_id,
            RecordingRequest.place == "clinic",
            RecordingRequest.status != "cancelled",
            RecordingRequest.created_at <= end,
        )
    )
    out = []
    for r, ncid in rows:
        when = _when(db, r)
        a = db.get(Appointment, r.appointment_id) if r.appointment_id else None
        if start <= when < end and not (a and a.status == "cancelled"):
            out.append(_item(db, r, ncid))
    return sorted(out, key=lambda q: q.at)


def _op_name(db: DbSession, operator_id: str | None) -> str | None:
    op = db.get(Operator, operator_id) if operator_id else None
    return (f"{op.name} ({op.code})" if op.name else op.code) if op else None


def _item(db: DbSession, r: RecordingRequest, ncid: str) -> QueueItem:
    a = db.get(Appointment, r.appointment_id) if r.appointment_id else None
    s = db.scalar(select(Session).where(Session.request_id == r.id).order_by(Session.started_at.desc()))
    by = _op_name(db, r.not_done_by) if r.status == "not_done" else _op_name(db, s.operator_id if s else None)
    return QueueItem(
        request_id=r.id,
        ncid=ncid,
        at=_when(db, r),
        doctor_name=_staff_name(db, a.doctor_id if a else r.created_by),
        tests=list(r.tests),
        med_state=r.med_state,
        state=request_state(db, r),
        recorded_by=by,
        not_done_reason=r.not_done_reason,
    )


class NotDoneIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str = Field(pattern=r"^[a-z_]+$", max_length=30)


@router.post("/requests/{req_id}/not-done", response_model=QueueItem)
def not_done(
    req_id: str,
    body: NotDoneIn,
    p: Principal = Depends(operator_queue),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> QueueItem:
    """The operator could not record this clinic request (did not attend, unwell, refused, …)."""
    if body.reason not in policy()["requests"]["clinicNotDoneReasons"]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "unknown_reason"})
    r = db.get(RecordingRequest, req_id)
    if not r or r.site_id != p.site_id or r.place != "clinic" or r.status == "cancelled":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "request not found")
    if request_state(db, r) == "recorded":
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "already_recorded"})
    r.status, r.not_done_reason, r.not_done_by = "not_done", body.reason, p.actor_id
    audit(
        db,
        p.actor_type,
        p.actor_id,
        "clinic_not_recorded",
        "patient",
        r.patient_id,
        site_id=p.site_id,
        reason=body.reason,
        appointment=r.appointment_id,
    )
    db.commit()
    pt = db.get(Patient, r.patient_id)
    assert pt is not None
    return _item(db, r, pt.ncid)
