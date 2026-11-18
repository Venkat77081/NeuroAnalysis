"""v14 (decision 046): the desk offers held times, the patient chooses, asks for a call or cancels;
cancellations with reasons; booking from the app; recordings follow a moved appointment."""

from datetime import UTC, datetime, timedelta

from test_appointment_changes import _local, _setup
from test_patient_app import home_patient
from test_readiness_api import _upload_take
from test_tenancy import (  # noqa: F401 - fixtures
    SESSION,
    _clean,
    hdr,
    platform,
    two_hospitals,
)


def _kolkata(api, t):
    api.put("/hospital/settings", headers=hdr(t["a_tok"]), json={"time_zone": "Asia/Kolkata"})


def _appt(api, desk, ncid, at, doctor):
    r = api.post(
        "/hospital/appointments", headers=desk, json={"ncid": ncid, "at": at.isoformat(), "doctor_id": doctor}
    )
    assert r.status_code == 201, r.text
    return r.json()


def _notices(kind: str) -> int:
    from app.db import _factory
    from app.models import AppointmentNotice

    with _factory()() as db:
        return db.query(AppointmentNotice).filter(AppointmentNotice.kind == kind).count()


def _expire(offer_id: str) -> None:
    from app.db import _factory
    from app.models import AppointmentOffer

    with _factory()() as db:
        db.get(AppointmentOffer, offer_id).reply_by = datetime.now(UTC) - timedelta(minutes=1)
        db.commit()


def test_offer_choose_hold_and_recording_moves(api, two_hospitals):
    t = two_hospitals
    _kolkata(api, t)
    desk, dr1, docs, ncid, ptok = _setup(api, t)
    rao, menon = docs["v13-rao@sunrise.example"], docs["v13-menon@sunrise.example"]
    a = _appt(api, desk, ncid, _local(4, 10), rao)
    assert api.post(f"/hospital/appointments/{a['id']}/request", headers=dr1, json={}).status_code == 201

    # The desk offers three times (one with another doctor); a fourth is refused.
    opts = [
        {"at": _local(6, 9, 30).isoformat(), "doctor_id": menon},
        {"at": _local(7, 11).isoformat(), "doctor_id": rao},
        {"at": _local(8, 12).isoformat(), "doctor_id": rao},
    ]
    body = {"appointment_id": a["id"], "options": opts, "reason": "doctor_unavailable"}
    four = {**body, "options": [*opts, {"at": _local(9, 10).isoformat(), "doctor_id": rao}]}
    assert api.post("/hospital/offers", headers=desk, json=four).json()["detail"] == {
        "code": "too_many_options"
    }
    r = api.post("/hospital/offers", headers=desk, json=body)
    assert r.status_code == 201, r.text
    offer = r.json()
    assert (
        offer["status"] == "open"
        and not offer["no_answer"]
        and [o["other_doctor"] for o in offer["options"]]
        == [
            True,
            False,
            False,
        ]
    )
    assert _notices("offer") == 1

    # Held: not free for anyone else (desk free times, other patients).
    day = _local(7, 0).date().isoformat()
    av = api.get(f"/hospital/availability?date={day}", headers=desk).json()
    rao_day = next(d for d in av["doctors"] if d["doctor_id"] == rao)
    assert "11:00" in rao_day["held"] and "11:00" not in rao_day["free"]
    _, other = home_patient(api, t["a_desk"])
    otok = hdr(other["tokens"]["access_token"])
    free = api.get(f"/patient/free-times?date={day}&doctor_id={rao}", headers=otok).json()
    assert "11:00" not in [x["time"] for x in free["times"]] and "11:30" in [x["time"] for x in free["times"]]

    # The patient sees the offer (no change can be asked meanwhile) and chooses Dr. Rao's time.
    pa = api.get("/patient/appointments", headers=ptok).json()["appointments"][0]
    assert pa["offer"]["id"] == offer["id"] and not pa["can_ask"] and pa["can_cancel"]
    assert api.post(f"/patient/offers/{offer['id']}/keep", headers=ptok).json()["detail"] == {
        "code": "cannot_keep"
    }
    r = api.post(f"/patient/offers/{offer['id']}/choose", headers=ptok, json={"index": 1})
    assert r.status_code == 200, r.text
    moved = {x["id"]: x for x in api.get("/hospital/appointments?days=14", headers=desk).json()}[a["id"]]
    assert datetime.fromisoformat(moved["at"]) == _local(7, 11) and moved["doctor_id"] == rao
    # Same doctor, not recorded: the record-by date is 1 day before the new date.
    assert datetime.fromisoformat(moved["requests"][0]["due_at"]) == _local(6, 11)
    assert moved["offer_state"] is None
    pa = api.get("/patient/appointments", headers=ptok).json()["appointments"][0]
    assert pa["offer"] is None and pa["moved_from"] and not pa["moved_by_hospital"]
    assert (
        api.post(f"/patient/offers/{offer['id']}/choose", headers=ptok, json={"index": 0}).status_code == 409
    )
    # Released: the other offered times are free again.
    free = api.get(
        f"/patient/free-times?date={_local(8, 0).date().isoformat()}&doctor_id={rao}", headers=otok
    )
    assert "12:00" in [x["time"] for x in free.json()["times"]]


def test_recordings_follow_the_appointment(api, two_hospitals):
    t = two_hospitals
    _kolkata(api, t)
    desk, dr1, docs, _, _ = _setup(api, t)
    rao, menon = docs["v13-rao@sunrise.example"], docs["v13-menon@sunrise.example"]
    ncid, acc = home_patient(api, t["a_desk"])
    ptok = hdr(acc["tokens"]["access_token"])
    a = _appt(api, desk, ncid, _local(3, 10), rao)
    req = api.post(f"/hospital/appointments/{a['id']}/request", headers=dr1, json={}).json()[0]
    # Recorded (the session started on 15 Nov 2026).
    sid = api.post("/sessions", headers=ptok, json={**SESSION, "request_id": req["id"]}).json()["id"]
    take_id = _upload_take(api, acc["tokens"], sid, acc["server_key"], "tk-v14")
    assert api.post(f"/takes/{take_id}/complete", headers=ptok).status_code == 200

    def move(days, doctor=None):
        r = api.post(
            f"/hospital/appointments/{a['id']}/move",
            headers=desk,
            json={
                "at": _local(days, 10).isoformat(),
                "reason": "clinic_change",
                "doctor_id": doctor,
                "notify": False,
            },
        )
        assert r.status_code == 200, r.text
        return r.json()

    recorded_on = datetime(2026, 11, 15, tzinfo=UTC)
    within = (recorded_on + timedelta(days=13) - datetime.now(UTC)).days
    m = move(max(within, 1))
    assert [r["state"] for r in m["requests"]] == ["recorded"]  # it counts for the new date
    m = move(25)
    assert [r["state"] for r in m["requests"]] == ["recorded", "open"]  # too old: a new link
    assert datetime.fromisoformat(m["requests"][1]["due_at"]) == _local(24, 10)
    assert m["requests"][1]["tests"] == req["tests"]
    # Another doctor, the new link not recorded: withdrawn; the new doctor confirms the tests.
    m = move(26, menon)
    assert [r["state"] for r in m["requests"]] == ["recorded", "cancelled"] and m["stage"] == "recorded"
    assert m["suggested_tests"]["tests"] == req["tests"]


def test_no_answer_call_keep_and_decline(api, two_hospitals):
    t = two_hospitals
    _kolkata(api, t)
    desk, _, docs, ncid, ptok = _setup(api, t)
    rao = docs["v13-rao@sunrise.example"]
    a = _appt(api, desk, ncid, _local(4, 10), rao)
    opt = [{"at": _local(6, 10).isoformat(), "doctor_id": rao}]

    # No answer by the deadline: the appointment stays; the desk sees "No answer".
    o = api.post(
        "/hospital/offers",
        headers=desk,
        json={"appointment_id": a["id"], "options": opt, "current_possible": True, "notify": False},
    ).json()
    _expire(o["id"])
    box = api.get("/hospital/inbox", headers=desk).json()
    assert [(x["id"], x["no_answer"]) for x in box["offers"]] == [(o["id"], True)] and box["count"] == 1
    listed = {x["id"]: x for x in api.get("/hospital/appointments?days=14", headers=desk).json()}[a["id"]]
    assert listed["offer_state"] == "no_answer" and datetime.fromisoformat(listed["at"]) == _local(4, 10)

    # A new offer replaces it; the patient keeps the current date (still possible).
    o = api.post(
        "/hospital/offers",
        headers=desk,
        json={"appointment_id": a["id"], "options": opt, "current_possible": True, "notify": False},
    ).json()
    assert len(api.get("/hospital/inbox", headers=desk).json()["offers"]) == 1
    assert api.post(f"/patient/offers/{o['id']}/keep", headers=ptok).status_code == 204
    assert api.get("/hospital/inbox", headers=desk).json()["offers"] == []

    # Asks to be called: counted for the desk, who withdraws the offer after phoning.
    o = api.post("/hospital/offers", headers=desk, json={"appointment_id": a["id"], "options": opt}).json()
    assert api.post(f"/patient/offers/{o['id']}/call", headers=ptok).status_code == 204
    box = api.get("/hospital/inbox", headers=desk).json()
    assert box["offers"][0]["status"] == "call_requested" and box["count"] == 1
    assert api.post(f"/hospital/offers/{o['id']}/withdraw", headers=desk).status_code == 204

    # None work: the patient cancels with a reason; the desk sees it until "seen".
    o = api.post("/hospital/offers", headers=desk, json={"appointment_id": a["id"], "options": opt}).json()
    bad = api.post(f"/patient/offers/{o['id']}/decline", headers=ptok, json={"reason": "bored"})
    assert bad.status_code == 422
    assert (
        api.post(
            f"/patient/offers/{o['id']}/decline", headers=ptok, json={"reason": "feeling_better"}
        ).status_code
        == 204
    )
    box = api.get("/hospital/inbox", headers=desk).json()
    assert [(c["appointment_id"], c["reason"]) for c in box["cancellations"]] == [(a["id"], "feeling_better")]
    assert box["count"] == 0
    assert api.post(f"/hospital/appointments/{a['id']}/cancellation-seen", headers=desk).status_code == 204
    assert api.get("/hospital/inbox", headers=desk).json()["cancellations"] == []
    pa = api.get("/patient/appointments", headers=ptok).json()["appointments"][0]
    assert pa["status"] == "cancelled" and pa["cancelled_by"] == "patient"

    # A patient not in the app cannot be offered times.
    other = api.post("/hospital/patients/invite", headers=hdr(t["a_desk"]), json={"channel": "print"}).json()
    b = _appt(api, desk, other["ncid"], _local(5, 10), rao)
    r = api.post("/hospital/offers", headers=desk, json={"appointment_id": b["id"], "options": opt})
    assert r.status_code == 409 and r.json()["detail"] == {"code": "not_joined"}


def test_cancel_by_desk_and_patient(api, two_hospitals):
    t = two_hospitals
    desk, _, docs, ncid, ptok = _setup(api, t)
    rao = docs["v13-rao@sunrise.example"]
    a = _appt(api, desk, ncid, _local(4, 10), rao)
    b = _appt(api, desk, ncid, _local(5, 10), rao)
    bad = api.post(f"/hospital/appointments/{a['id']}/cancel", headers=desk, json={"reason": "whim"})
    assert bad.status_code == 422
    r = api.post(
        f"/hospital/appointments/{a['id']}/cancel", headers=desk, json={"reason": "doctor_unavailable"}
    )
    assert (
        r.status_code == 200
        and r.json()["status"] == "cancelled"
        and r.json()["cancel_reason"] == "doctor_unavailable"
    )
    assert _notices("cancelled") == 1
    again = api.post(f"/hospital/appointments/{a['id']}/cancel", headers=desk, json={"reason": "other"})
    assert again.status_code == 409
    # The patient cancels the other one, at any time.
    assert (
        api.post(
            f"/patient/appointments/{b['id']}/cancel", headers=ptok, json={"reason": "cant_make_it"}
        ).status_code
        == 204
    )
    out = {x["id"]: x for x in api.get("/patient/appointments", headers=ptok).json()["appointments"]}
    assert out[a["id"]]["cancelled_by"] == "staff" and out[b["id"]]["cancelled_by"] == "patient"
    hist = api.get(f"/hospital/appointments/{b['id']}/history", headers=desk).json()
    assert hist[-1]["action"] == "appointment_cancelled" and hist[-1]["details"]["by"] == "patient"
    # v17: the patient's Appointment history lists both cancellations, newest first.
    past = api.get("/patient/appointments/history", headers=ptok).json()
    assert [(x["id"], x["status"], x["cancelled_by"]) for x in past] == [
        (b["id"], "cancelled", "patient"),
        (a["id"], "cancelled", "staff"),
    ]


def test_change_request_answered_with_alternatives(api, two_hospitals):
    t = two_hospitals
    _kolkata(api, t)
    desk, _, docs, ncid, ptok = _setup(api, t)
    rao, menon = docs["v13-rao@sunrise.example"], docs["v13-menon@sunrise.example"]
    a = _appt(api, desk, ncid, _local(4, 10), rao)
    # Another patient takes Dr. Rao's 10:00 on day 7 after the request.
    ask = {"choices": [{"at": _local(7, 10).isoformat(), "rank": "preferred"}], "reason": "travel"}
    cid = api.post(f"/patient/appointments/{a['id']}/change-request", headers=ptok, json=ask).json()["id"]
    other, _ = home_patient(api, t["a_desk"])
    _appt(api, desk, other, _local(7, 10), rao)
    [req] = api.get("/hospital/inbox", headers=desk).json()["requests"]
    assert req["choices"][0]["state"] == "taken" and req["joined"]
    # The desk offers alternatives for the request; the patient picks Dr. Menon's.
    o = api.post(
        "/hospital/offers",
        headers=desk,
        json={
            "request_id": cid,
            "options": [
                {"at": _local(7, 11).isoformat(), "doctor_id": rao},
                {"at": _local(7, 10).isoformat(), "doctor_id": menon},
            ],
            "reason": "patient_request",
        },
    ).json()
    assert api.get("/hospital/inbox", headers=desk).json()["requests"] == []
    pa = api.get("/patient/appointments", headers=ptok).json()["appointments"][0]
    assert pa["change"]["status"] == "offered" and pa["offer"]["id"] == o["id"]
    assert api.post(f"/patient/offers/{o['id']}/choose", headers=ptok, json={"index": 1}).status_code == 200
    pa = api.get("/patient/appointments", headers=ptok).json()["appointments"][0]
    assert pa["change"]["status"] == "accepted" and pa["doctor_name"] and pa["moved_from_doctor_name"]


def test_booking_from_the_app(api, two_hospitals):
    t = two_hospitals
    _kolkata(api, t)
    desk, _, docs, ncid, ptok = _setup(api, t)
    rao, menon = docs["v13-rao@sunrise.example"], docs["v13-menon@sunrise.example"]
    admin = hdr(t["a_tok"])
    # Dr. Menon is not bookable in the app.
    from test_appointment_changes import WEEK

    api.put(
        f"/hospital/doctor-hours/{menon}",
        headers=admin,
        json={"week": WEEK, "slot_minutes": 30, "bookable": False},
    )
    doctors = api.get("/patient/doctors", headers=ptok).json()
    assert [d["id"] for d in doctors] == [rao]
    out = api.get("/patient/appointments", headers=ptok).json()
    assert out["booking"] == {
        "enabled": True,
        "preferred": 2,
        "alternatives": 2,
        "times_per_date": 2,
        "days_ahead": 60,
        "min_days": 2,
    }
    # Free times start after the minimum days.
    tomorrow = _local(1, 0).date().isoformat()
    assert api.get(f"/patient/free-times?date={tomorrow}&doctor_id={rao}", headers=ptok).json()["times"] == []
    day5 = _local(5, 0).date().isoformat()
    assert len(api.get(f"/patient/free-times?date={day5}", headers=ptok).json()["times"]) == 14
    # v17: free times per day for the app's calendar (same rules as one day).
    q = f"from={tomorrow}&to={day5}&doctor_id={rao}"
    days = api.get(f"/patient/free-days?{q}", headers=ptok).json()["days"]
    assert days[0] == {"date": tomorrow, "free": 0} and days[-1] == {"date": day5, "free": 14}
    far = _local(80, 0).date().isoformat()
    assert api.get(f"/patient/free-days?from={tomorrow}&to={far}", headers=ptok).status_code == 422

    choices = [
        {"at": _local(5, 9, 30).isoformat(), "rank": "preferred"},
        {"at": _local(5, 10).isoformat(), "rank": "preferred"},
        {"at": _local(6, 11).isoformat(), "rank": "preferred"},
        {"at": _local(8, 14, 30).isoformat(), "rank": "alternative"},
        {"at": _local(9, 9).isoformat(), "rank": "alternative"},
    ]
    body = {"doctor_id": rao, "choices": choices, "purpose": "follow_up"}
    for bad in (
        {**body, "doctor_id": menon},
        {**body, "choices": [*choices, {"at": _local(7, 9).isoformat(), "rank": "preferred"}]},
        {**body, "choices": [{"at": _local(1, 10).isoformat(), "rank": "preferred"}]},
        {**body, "purpose": "chat"},
    ):
        assert api.post("/patient/bookings", headers=ptok, json=bad).status_code == 422
    r = api.post("/patient/bookings", headers=ptok, json=body)
    assert r.status_code == 201, r.text
    bid = r.json()["id"]
    assert api.post("/patient/bookings", headers=ptok, json=body).json()["detail"] == {
        "code": "booking_already_asked"
    }

    # Day 5, 9:30 is taken meanwhile; the desk sees each choice checked and books alternative 1.
    other, _ = home_patient(api, t["a_desk"])
    _appt(api, desk, other, _local(5, 9, 30), rao)
    [req] = api.get("/hospital/inbox", headers=desk).json()["requests"]
    assert req["kind"] == "booking" and req["purpose"] == "follow_up" and req["appointment_id"] is None
    assert [c["state"] for c in req["choices"]] == ["taken", "free", "free", "free", "free"]
    r = api.post(
        f"/hospital/change-requests/{bid}/book", headers=desk, json={"at": _local(8, 14, 30).isoformat()}
    )
    assert r.status_code == 200, r.text
    assert r.json()["source"] == "app" and r.json()["doctor_id"] == rao
    assert _notices("booked") == 1
    out = api.get("/patient/appointments", headers=ptok).json()
    assert [datetime.fromisoformat(x["at"]) for x in out["appointments"]] == [_local(8, 14, 30)]
    assert out["bookings"] == []

    # A second booking: declined with a reason; a third: answered with an offer the patient takes.
    body2 = {"doctor_id": None, "choices": [{"at": _local(10, 10).isoformat(), "rank": "preferred"}]}
    b2 = api.post("/patient/bookings", headers=ptok, json=body2).json()["id"]
    r = api.post(f"/hospital/change-requests/{b2}/decline", headers=desk, json={"answer": "fully_booked"})
    assert r.status_code == 200 and r.json()["status"] == "declined"
    out = api.get("/patient/appointments", headers=ptok).json()
    assert [(b["status"], b["answer"]) for b in out["bookings"]] == [("declined", "fully_booked")]
    b3 = api.post("/patient/bookings", headers=ptok, json=body2).json()["id"]
    o = api.post(
        "/hospital/offers",
        headers=desk,
        json={
            "request_id": b3,
            "options": [{"at": _local(11, 12).isoformat(), "doctor_id": rao}],
            "reason": "patient_request",
        },
    ).json()
    assert o["kind"] == "booking"
    assert api.post(f"/patient/offers/{o['id']}/choose", headers=ptok, json={"index": 0}).status_code == 200
    out = api.get("/patient/appointments", headers=ptok).json()
    assert len(out["appointments"]) == 2 and [b["id"] for b in out["bookings"]] == [b2]

    # Turned off: no more bookings.
    api.put("/hospital/settings", headers=admin, json={"patient_booking": False, "booking_preferred": 1})
    r = api.post("/patient/bookings", headers=ptok, json=body2)
    assert r.json()["detail"] == {"code": "booking_off"}
    bad = api.put("/hospital/settings", headers=admin, json={"offer_max": 9})
    assert bad.json()["detail"] == {"code": "setting_not_offered", "setting": "offer_max"}
