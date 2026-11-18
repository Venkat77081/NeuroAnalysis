"""v13: settings a hospital admin changes in the dashboard (Site.settings), over the defaults in
config/platform.json: the phones' camera-check pass level, how long before an appointment patients
may ask to change it, whether they may ask at all, and the hospital's time zone (clinic hours and
the patient's chosen days are in it)."""

from datetime import date, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.models import Site
from app.policy import policy


def defaults(site: Site | None) -> dict:
    pol = policy()
    ch = pol["appointmentChanges"]
    region = (site.region if site else "") or ""
    return {
        "device_min_fps": float(pol["deviceCheck"]["minFps"]),
        "change_cutoff_hours": int(ch["cutoffHours"]),
        "patient_changes": True,
        "time_zone": ch["timeZones"].get(region.upper(), ch["defaultTimeZone"]),
    }


def site_settings(site: Site | None) -> dict:
    out = defaults(site)
    for k, v in ((site.settings if site else None) or {}).items():
        if k in out and v is not None:
            out[k] = v
    return out


def valid_time_zone(name: str) -> bool:
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return False
    return True


def site_tz(site: Site | None) -> ZoneInfo:
    name = site_settings(site)["time_zone"]
    return ZoneInfo(name) if valid_time_zone(name) else ZoneInfo("UTC")


def local_day(site: Site | None, at: datetime) -> date:
    return at.astimezone(site_tz(site)).date()
