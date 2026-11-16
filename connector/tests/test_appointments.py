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
