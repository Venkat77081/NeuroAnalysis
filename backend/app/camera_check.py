"""Camera check before a phone is added (user, 16 Nov 2026). The phone records for
`deviceCheck.durationS` seconds before it uses a registration code (clinic phones) or accepts an
invite (patients); it needs `deviceCheck.minFps` frames per second or more. The code or invite is
not used up by a failed check, so it still works on another phone."""

from datetime import datetime

from fastapi import HTTPException, status
from pydantic import BaseModel, Field

from app.policy import policy


class CameraCheckIn(BaseModel):
    #: Frames per second measured by the phone over the check (back camera, 1080p, 60 requested).
    effective_fps: float = Field(ge=0, le=240)
    ran_at: datetime | None = None


def require_passing(check: CameraCheckIn | None) -> float:
    """The measured fps, or 422 when the check is missing or below the minimum."""
    need = float(policy()["deviceCheck"]["minFps"])
    if check is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY, {"code": "camera_check_required", "min_fps": need}
        )
    if check.effective_fps < need:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            {"code": "camera_check_failed", "min_fps": need, "fps": check.effective_fps},
        )
    return check.effective_fps
