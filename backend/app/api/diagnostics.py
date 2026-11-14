"""Client diagnostics (M9): PII-safe crash reports from the phone, kept as audit events.

The phone redacts reports before sending (no patient data, no IDs, no file paths). The server
still bounds their size and keeps only known fields.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.audit import audit
from app.db import get_db
from app.models import AuditEvent, Device
from app.security import Principal, current_principal, require_role

router = APIRouter(prefix="/diagnostics", tags=["diagnostics"])


class CrashReport(BaseModel):
    source: str = Field(pattern=r"^(js|native)$")
    at: datetime
    app_version: str = Field(max_length=20)
    plugin_version: str = Field(max_length=20)
    platform: str = Field(max_length=40)
    error: str = Field(max_length=100)
    message: str = Field(max_length=500)
    stack: list[str] = Field(default_factory=list, max_length=40)
    screen: str | None = Field(default=None, max_length=60)


class DiagnosticIn(BaseModel):
    kind: str = Field(pattern=r"^crash$")
    report: CrashReport


@router.post("", status_code=status.HTTP_201_CREATED)
def post_diagnostic(
    body: DiagnosticIn,
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> dict:
    report = body.report.model_dump(mode="json")
    report["stack"] = [line[:200] for line in report["stack"]]
    audit(db, "device", p.device.id, "client_crash", "device", p.device.id, **report)
    db.commit()
    return {"status": "stored"}


@router.get("")
def list_diagnostics(
    limit: int = Query(default=50, ge=1, le=500),
    p: Principal = Depends(require_role("admin")),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
) -> list[dict]:
    devices = select(Device.id).where(Device.site_id == p.operator.site_id)
    rows = db.scalars(
        select(AuditEvent)
        .where(AuditEvent.action == "client_crash", AuditEvent.actor_id.in_(devices))
        .order_by(AuditEvent.at.desc())
        .limit(limit)
    )
    return [{"deviceId": r.actor_id, "at": r.at.isoformat(), **(r.details or {})} for r in rows]
