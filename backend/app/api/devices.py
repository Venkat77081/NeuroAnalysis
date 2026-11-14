from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession

from app.audit import audit
from app.db import get_db
from app.models import Device
from app.security import Principal, current_principal

router = APIRouter(prefix="/devices", tags=["devices"])


class TierOut(BaseModel):
    device_id: str
    tier: str | None


class QualificationIn(BaseModel):
    tier: str
    report: dict


def _own(p: Principal, device_id: str, db: DbSession) -> Device:
    dev = db.get(Device, device_id)
    if not dev or dev.site_id != p.operator.site_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "device not found")
    return dev


@router.get("/{device_id}/tier", response_model=TierOut)
def get_tier(device_id: str, p: Principal = Depends(current_principal), db: DbSession = Depends(get_db)):  # noqa: B008
    return TierOut(device_id=device_id, tier=_own(p, device_id, db).tier)


@router.put("/{device_id}/qualification", response_model=TierOut)
def put_qualification(
    device_id: str,
    body: QualificationIn,
    p: Principal = Depends(current_principal),  # noqa: B008
    db: DbSession = Depends(get_db),  # noqa: B008
):
    if device_id != p.device.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the device itself reports its qualification")
    dev = _own(p, device_id, db)
    if body.tier not in {"A", "B", "C"}:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "tier must be A, B or C")
    dev.tier = body.tier
    dev.qualification_report = body.report
    audit(db, "device", dev.id, "qualification_reported", tier=body.tier)
    db.commit()
    return TierOut(device_id=device_id, tier=dev.tier)
