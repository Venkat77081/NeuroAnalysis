"""Readiness reports (DEV_PLAN §10, M8): per take and per session, reviewer/admin only."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.db import get_db
from app.models import Device, Session, Take
from app.readiness import compute, latest, take_report
from app.security import Principal, require_role

router = APIRouter(tags=["readiness"])
reviewer = require_role("reviewer", "admin")


def _site_take(db: DbSession, p: Principal, take_id: str) -> Take:
    t = db.get(Take, take_id)
    s = db.get(Session, t.session_id) if t else None
    d = db.get(Device, s.device_id) if s else None
    if not t or not d or d.site_id != p.operator.site_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "take not found")
    if t.status != "complete":
        raise HTTPException(status.HTTP_409_CONFLICT, {"code": "take_not_uploaded"})
    return t


@router.post("/takes/{take_id}/readiness")
def recompute_take(take_id: str, p: Principal = Depends(reviewer), db: DbSession = Depends(get_db)):  # noqa: B008
    t = _site_take(db, p, take_id)
    return take_report(t, compute(db, t, p.operator.id))


@router.get("/takes/{take_id}/readiness")
def take_readiness(take_id: str, p: Principal = Depends(reviewer), db: DbSession = Depends(get_db)):  # noqa: B008
    t = _site_take(db, p, take_id)
    return take_report(t, latest(db, t) or compute(db, t, p.operator.id))


@router.get("/sessions/{session_id}/readiness")
def session_readiness(session_id: str, p: Principal = Depends(reviewer), db: DbSession = Depends(get_db)):  # noqa: B008
    s = db.get(Session, session_id)
    d = db.get(Device, s.device_id) if s else None
    if not s or not d or d.site_id != p.operator.site_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "session not found")
    takes = db.scalars(
        select(Take).where(Take.session_id == s.id, Take.status == "complete").order_by(Take.created_at)
    ).all()
    reports = [take_report(t, latest(db, t) or compute(db, t, p.operator.id)) for t in takes]
    by_test: dict[str, dict[str, int]] = {}
    for r in reports:
        agg = by_test.setdefault(r["testCode"], {})
        for k, n in r["summary"].items():
            agg[k] = agg.get(k, 0) + n
    return {"sessionId": s.id, "clientSessionId": s.client_session_id, "byTest": by_test, "takes": reports}
