"""Phone details from the phone check (decision 062): brand, model, Android version, camera fps,
video size, memory (RAM) and storage. Kept per phone (Device.device_report) for the platform's and the
hospital's Phones pages; patients are shown by NCID only, never by name or MRN.

Memory is compared in the phone's nominal size: Android reports a little less than the label
(a "4 GB" phone shows about 3.7 GiB), so the reported bytes are rounded up to whole GiB.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.config import get_settings
from app.models import Device
from app.policy import policy

GIB = 1 << 30


class PhoneIn(BaseModel):
    """What a phone sends about itself; every field optional (older apps send none)."""

    brand: str | None = Field(default=None, max_length=60)
    manufacturer: str | None = Field(default=None, max_length=60)
    video_width: int | None = Field(default=None, ge=0, le=10000)
    video_height: int | None = Field(default=None, ge=0, le=10000)
    #: Bytes per second of the check's test video, measured before it was deleted.
    video_bytes_per_s: float | None = Field(default=None, ge=0, le=1e9)
    ram_total_bytes: int | None = Field(default=None, ge=0)
    ram_free_bytes: int | None = Field(default=None, ge=0)
    ram_low: bool | None = None
    storage_free_bytes: int | None = Field(default=None, ge=0)
    storage_total_bytes: int | None = Field(default=None, ge=0)
    #: v36 (decision 063): the hand-sign try-out on a patient's phone, and the tracking rate.
    start_sign: Literal["works", "too_slow", "not_seen", "skipped"] | None = None
    tracking_hz: float | None = Field(default=None, ge=0, le=240)


class PhoneStatusIn(PhoneIn):
    """A later report: a check run again from the menu (with fps), or the quick check before a visit."""

    effective_fps: float | None = Field(default=None, ge=0, le=240)
    #: "check" = the full phone check (camera too); "visit" = storage and memory before a visit.
    kind: str = Field(default="visit", pattern="^(check|visit)$")


def start_gb() -> float:
    """config/session.json storage.minFreeGbToStart: no visit starts with less free space."""
    import json
    from pathlib import Path

    s = json.loads((Path(get_settings().config_dir) / "session.json").read_text())
    return float(s["storage"]["minFreeGbToStart"])


def nominal_gb(total_bytes: int | None) -> int | None:
    return math.ceil(total_bytes / GIB) if total_bytes else None


def memory_too_small(total_bytes: int | None) -> bool:
    gb = nominal_gb(total_bytes)
    return gb is not None and gb < float(policy()["deviceCheck"]["memory"]["minTotalGb"])


def apply_phone(dev: Device, data: PhoneIn | None, *, fps: float | None = None, kind: str = "check") -> None:
    """Merges what the phone sent into its record (fields it left out keep their last value)."""
    if data is None and fps is None:
        return
    now = datetime.now(UTC)
    info = dict(dev.device_report or {})
    if data is not None:
        for k, v in data.model_dump(exclude={"effective_fps", "kind"}).items():
            if v is not None:
                info[k] = v
    if fps is not None and kind == "check":
        dev.check_fps, dev.checked_at = fps, now
    info["last_report"] = kind
    dev.device_report = info
    dev.device_report_at = now


def status_of(dev: Device) -> str:
    """One status for the Phones pages, worst first: camera_too_slow, memory_too_small, cannot_record,
    storage_low, memory_low, camera_slow, ready (or unchecked)."""
    dc = policy()["deviceCheck"]
    info = dev.device_report or {}
    fps = dev.check_fps
    if fps is None and not info:
        return "unchecked"
    if fps is not None and fps < float(dc["minFps"]):
        return "camera_too_slow"
    if memory_too_small(info.get("ram_total_bytes")):
        return "memory_too_small"
    free = info.get("storage_free_bytes")
    if free is not None and free < start_gb() * 1e9:
        return "cannot_record"
    if free is not None and free < float(dc["storage"]["warnFreeBelowGb"]) * 1e9:
        return "storage_low"
    gb = nominal_gb(info.get("ram_total_bytes"))
    m = dc["memory"]
    low_free = info.get("ram_low") or (
        info.get("ram_free_bytes") is not None and info["ram_free_bytes"] < float(m["warnFreeBelowGb"]) * 1e9
    )
    if (gb is not None and gb < float(m["warnTotalBelowGb"])) or low_free:
        return "memory_low"
    if fps is not None and fps < float(dc["warnBelowFps"]):
        return "camera_slow"
    return "ready"


class PhoneOut(BaseModel):
    brand: str | None = None
    video_width: int | None = None
    video_height: int | None = None
    video_bytes_per_s: float | None = None
    ram_total_gb: int | None = None
    ram_free_bytes: int | None = None
    ram_low: bool | None = None
    storage_free_bytes: int | None = None
    storage_total_bytes: int | None = None
    start_sign: str | None = None
    tracking_hz: float | None = None
    reported_at: datetime | None = None
    status: str = "unchecked"


def phone_out(dev: Device) -> PhoneOut:
    info = dev.device_report or {}
    return PhoneOut(
        brand=info.get("brand") or info.get("manufacturer"),
        video_width=info.get("video_width"),
        video_height=info.get("video_height"),
        video_bytes_per_s=info.get("video_bytes_per_s"),
        ram_total_gb=nominal_gb(info.get("ram_total_bytes")),
        ram_free_bytes=info.get("ram_free_bytes"),
        ram_low=info.get("ram_low"),
        storage_free_bytes=info.get("storage_free_bytes"),
        storage_total_bytes=info.get("storage_total_bytes"),
        start_sign=info.get("start_sign"),
        tracking_hz=info.get("tracking_hz"),
        reported_at=dev.device_report_at,
        status=status_of(dev),
    )
