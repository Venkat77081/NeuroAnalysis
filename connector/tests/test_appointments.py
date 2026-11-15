"""v3 on the connector: reception sees appointments live from the hospital's FHIR system (names and
NCIDs next to them); reminders for open record links are sent with the hospital's contact details."""

from datetime import UTC, datetime, timedelta

from test_e2e import accept, ctoken
from test_tenancy import hdr, sign_up, staff_login


def _staff(env, email, role):
    api = env["platform"]
    api.post("/hospital/staff", headers=hdr(env["admin_tok"]), json={"email": email, "role": role})
    _, secret = sign_up(api, email)
    return staff_login(api, email, secret)["access_token"]


def test_reception_sees_fhir_appointments(connector):
    env, c = connector, connector["client"]
    desk_pt = _staff(env, "desk@sunrise.example", "receptionist")
    dr_pt = _staff(env, "dr@sunrise.example", "doctor")
    desk = ctoken(env, desk_pt)
    inv = c.post("/v1/invites", headers=desk, json={"mrns": ["00012388"], "channel": "print"}).json()[0]

    rows = c.get("/v1/appointments", headers=desk).json()
    assert [(r["external_id"], r["mrn"], r["practitioner"]) for r in rows] == [
        ("Appointment/a1", "00012388", "Dr. Rao"),
        ("Appointment/a2", "00012401", "Dr. Rao"),
    ]  # the cancelled one is left out
    assert rows[0]["name"] == "Asha Testpatient" and rows[0]["ncid"] == inv["ncid"]
    assert rows[1]["ncid"] is None  # not invited yet
    assert c.get("/v1/appointments", headers=ctoken(env, dr_pt)).status_code == 403


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
