"""v18 (decision 049): the front desk marks that the patient did not come, from the appointment's
time on. The appointment is cancelled; the patient and the doctor are told."""

from datetime import UTC, datetime, timedelta

from test_appointment_changes import _local, _setup
from test_appointment_requests import _appt, _notices
from test_tenancy import (  # noqa: F401 - fixtures
    _clean,
    hdr,
    platform,
    two_hospitals,
)


def _to_past(appt_id: str, hours: float = 1) -> None:
    from app.db import _factory
    from app.models import Appointment

    with _factory()() as db:
        db.get(Appointment, appt_id).at = datetime.now(UTC) - timedelta(hours=hours)
        db.commit()


def test_no_show_cancels_and_tells_patient_and_doctor(api, two_hospitals):
    from app.providers import OUTBOX

    t = two_hospitals
    desk, _, docs, ncid, ptok = _setup(api, t)
    rao = docs["v13-rao@sunrise.example"]
    a = _appt(api, desk, ncid, _local(3, 10), rao)

    # Not before the appointment's time.
    r = api.post(f"/hospital/appointments/{a['id']}/no-show", headers=desk, json={})
    assert r.status_code == 409 and r.json()["detail"] == {"code": "not_yet"}

    _to_past(a["id"])
    OUTBOX.clear()
    r = api.post(f"/hospital/appointments/{a['id']}/no-show", headers=desk, json={})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["status"] == "cancelled" and out["cancel_reason"] == "no_show"
    assert _notices("no_show") == 1
    mail = [m for m in OUTBOX if m.to == "v13-rao@sunrise.example"]
    assert len(mail) == 1 and ncid in mail[0].body and "did not come" in mail[0].subject
    # Once only.
    again = api.post(f"/hospital/appointments/{a['id']}/no-show", headers=desk, json={})
    assert again.status_code == 409

    # The patient sees it in Appointment history; the activity log has the reason.
    past = api.get("/patient/appointments/history", headers=ptok).json()
    assert past[0]["id"] == a["id"] and past[0]["status"] == "no_show"
    hist = api.get(f"/hospital/appointments/{a['id']}/history", headers=desk).json()
    assert hist[-1]["action"] == "appointment_cancelled" and hist[-1]["details"]["reason"] == "no_show"

    # Without telling the patient: no notice (the doctor is still told).
    b = _appt(api, desk, ncid, _local(4, 10), rao)
    _to_past(b["id"], 2)
    r = api.post(f"/hospital/appointments/{b['id']}/no-show", headers=desk, json={"notify": False})
    assert r.status_code == 200 and _notices("no_show") == 1
    # The patient cannot mark it.
    c = _appt(api, desk, ncid, _local(5, 10), rao)
    _to_past(c["id"])
    assert api.post(f"/hospital/appointments/{c['id']}/no-show", headers=ptok, json={}).status_code in (
        401,
        403,
    )
    # Another hospital's desk cannot either.
    other = api.post(f"/hospital/appointments/{c['id']}/no-show", headers=hdr(t["b_desk"]), json={})
    assert other.status_code in (403, 404)
