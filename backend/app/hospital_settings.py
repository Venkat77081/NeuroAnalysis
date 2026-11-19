"""v13: settings a hospital admin changes in the dashboard (Site.settings), over the defaults in
config/platform.json: the phones' camera-check pass level, how long before an appointment patients
may ask to change it, whether they may ask at all, and the hospital's time zone (clinic hours and
the patient's chosen days are in it)."""

from datetime import date, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.models import Site
from app.policy import policy
from app.test_lengths import default_lengths


def defaults(site: Site | None) -> dict:
    pol = policy()
    ch = pol["appointmentChanges"]
    region = (site.region if site else "") or ""
    return {
        "device_min_fps": float(pol["deviceCheck"]["minFps"]),
        "change_cutoff_hours": int(ch["cutoffHours"]),
        "patient_changes": True,
        "time_zone": ch["timeZones"].get(region.upper(), ch["defaultTimeZone"]),
        # v14 (decision 046): booking from the app, the desk's offers, recordings after a move.
        "patient_booking": True,
        "booking_preferred": int(ch["bookingPreferred"]),
        "booking_alternatives": int(ch["bookingAlternatives"]),
        "times_per_date": int(ch["timesPerDate"]),
        "booking_days_ahead": int(ch["bookingDaysAhead"]),
        "booking_min_days": int(ch["bookingMinDays"]),
        "offer_max": int(ch["offerMax"]),
        "offer_reply_hours": int(ch["offerReplyHours"]),
        "recording_valid_days": int(ch["recordingValidDays"]),
        "record_due_days_before": int(pol["requests"]["defaultDueDaysBefore"]),
        # v16 (decision 047): consent on the clinic phone when the patient has no app.
        "clinic_phone_consent": True,
        # v31 (decision 054): each test's take length (config/tests), changed on Settings.
        "test_durations": default_lengths(),
    }


#: Settings chosen from a list in config/platform.json (`appointmentChanges`): key → options key.
OPTIONS = {
    "change_cutoff_hours": "cutoffHourOptions",
    "booking_preferred": "bookingPreferredOptions",
    "booking_alternatives": "bookingAlternativeOptions",
    "times_per_date": "timesPerDateOptions",
    "booking_days_ahead": "bookingDaysAheadOptions",
    "booking_min_days": "bookingMinDayOptions",
    "offer_max": "offerMaxOptions",
    "offer_reply_hours": "offerReplyHourOptions",
    "recording_valid_days": "recordingValidDayOptions",
    "record_due_days_before": "recordDueDaysBeforeOptions",
}


def site_settings(site: Site | None) -> dict:
    out = defaults(site)
    for k, v in ((site.settings if site else None) or {}).items():
        if k in out and v is not None:
            # Lengths merge per test, so a test added to config later keeps its default.
            out[k] = {**out[k], **v} if k == "test_durations" else v
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
