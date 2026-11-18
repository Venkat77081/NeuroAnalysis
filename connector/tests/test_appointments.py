"""v3 on the connector: reminders for open home record links are sent with the hospital's contact
details. (Appointments are added by hand on the platform; nothing is read from the hospital's
appointment system.)"""

from datetime import UTC, datetime, timedelta

from test_e2e import accept, ctoken
from test_tenancy import hdr, sign_up, staff_login


def _staff(env, email, role):
    api = env["platform"]
    api.post("/hospital/staff", headers=hdr(env["admin_tok"]), json={"email": email, "role": role})
    _, secret = sign_up(api, email)
    return staff_login(api, email, secret)["access_token"]


def test_reminder_sent_once_with_hospital_contacts(connector):
    from ncconnector.db import factory
    from ncconnector.providers import OUTBOX
    from ncconnector.reminders import send_due

    env, c, api = connector, connector["client"], connector["platform"]
    desk_pt = _staff(env, "desk2@sunrise.example", "receptionist")
    dr_pt = _staff(env, "dr2@sunrise.example", "doctor")
    inv = c.post(
        "/v1/invites", headers=ctoken(env, desk_pt), json={"mrns": ["00012388"], "channel": "print"}
    ).json()[0]
    accept(env, inv["invite_link"])
    dr_id = next(
        d["id"]
        for d in api.get("/hospital/doctors", headers=hdr(desk_pt)).json()
        if d["email"] == "dr2@sunrise.example"
    )
    at = datetime.now(UTC) + timedelta(days=2)
    appt = api.post(
        "/hospital/appointments",
        headers=hdr(desk_pt),
        json={"ncid": inv["ncid"], "at": at.isoformat(), "doctor_id": dr_id},
    ).json()
    due = datetime.now(UTC) + timedelta(hours=6)  # inside reminderHoursBefore
    r = api.post(
        f"/hospital/appointments/{appt['id']}/request",
        headers=hdr(dr_pt),
        json={"tests": ["FT"], "due_at": due.isoformat()},
    )
    assert r.status_code == 201, r.text

    OUTBOX.clear()
    with factory()() as db:
        assert send_due(db) == 1
        assert send_due(db) == 0  # marked sent on the platform
    [m] = OUTBOX
    assert m.channel == "email" and m.to == "asha.t@example.org"
    assert "Sunrise Neuro Clinic" in m.subject and "before your appointment on" in m.body


def test_appointment_moved_notice(connector):
    """v13: the desk moves an appointment with "tell the patient"; the connector sends it once."""
    from zoneinfo import ZoneInfo

    from ncconnector.db import factory
    from ncconnector.providers import OUTBOX
    from ncconnector.reminders import send_notices

    env, c, api = connector, connector["client"], connector["platform"]
    desk = _staff(env, "desk3@sunrise.example", "receptionist")
    _staff(env, "dr3@sunrise.example", "doctor")
    api.put("/hospital/settings", headers=hdr(env["admin_tok"]), json={"time_zone": "Asia/Kolkata"})
    inv = c.post(
        "/v1/invites", headers=ctoken(env, desk), json={"mrns": ["00012388"], "channel": "print"}
    ).json()[0]
    accept(env, inv["invite_link"])
    dr_id = next(
        d["id"]
        for d in api.get("/hospital/doctors", headers=hdr(desk)).json()
        if d["email"] == "dr3@sunrise.example"
    )
    at = datetime.now(UTC) + timedelta(days=3)
    appt = api.post(
        "/hospital/appointments",
        headers=hdr(desk),
        json={"ncid": inv["ncid"], "at": at.isoformat(), "doctor_id": dr_id},
    ).json()
    day = (datetime.now(ZoneInfo("Asia/Kolkata")) + timedelta(days=5)).date()
    new_at = datetime(day.year, day.month, day.day, 9, 45, tzinfo=ZoneInfo("Asia/Kolkata"))
    r = api.post(
        f"/hospital/appointments/{appt['id']}/move",
        headers=hdr(desk),
        json={"at": new_at.isoformat(), "reason": "doctor_unavailable", "notify": True},
    )
    assert r.status_code == 200, r.text

    OUTBOX.clear()
    with factory()() as db:
        assert send_notices(db) == 1
        assert send_notices(db) == 0  # marked sent on the platform
    [m] = OUTBOX
    assert m.channel == "email" and m.to == "asha.t@example.org"
    assert f"{new_at.strftime('%a %d %b')}, 9:45 am" in m.subject and "with " in m.body
