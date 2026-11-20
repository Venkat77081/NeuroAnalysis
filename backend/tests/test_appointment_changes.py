"""v13 (decision 045): the desk moves appointments, patients ask for another date, free times from
doctors' clinic hours, hospital settings (phones' pass level, change cut-off)."""

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from test_patient_app import _staff, home_patient
from test_tenancy import (  # noqa: F401 - fixtures
    _clean,
    hdr,
    platform,
    two_hospitals,
)

IST = ZoneInfo("Asia/Kolkata")
WEEK = {
    d: [["09:00", "13:00"], ["14:00", "17:00"]] for d in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
}


def _local(days: int, hh: int, mm: int = 0) -> datetime:
    d = (datetime.now(IST) + timedelta(days=days)).date()
    return datetime(d.year, d.month, d.day, hh, mm, tzinfo=IST)


def _setup(api, t):
    desk = _staff(api, t, "v13-desk@sunrise.example", "receptionist")
    dr1 = _staff(api, t, "v13-rao@sunrise.example", "doctor")
    _staff(api, t, "v13-menon@sunrise.example", "doctor")
    docs = {d["email"]: d["id"] for d in api.get("/hospital/doctors", headers=desk).json()}
    admin = hdr(t["a_tok"])
    for email, dept in (("v13-rao@sunrise.example", "Neurology"), ("v13-menon@sunrise.example", "Neurology")):
        r = api.put(
            f"/hospital/doctor-hours/{docs[email]}",
            headers=admin,
            json={"department": dept, "week": WEEK, "slot_minutes": 30},
        )
        assert r.status_code == 200, r.text
    ncid, acc = home_patient(api, t["a_desk"])
    return desk, dr1, docs, ncid, hdr(acc["tokens"]["access_token"])


def test_settings_and_hours(api, two_hospitals):
    t = two_hospitals
    admin, desk = hdr(t["a_tok"]), hdr(t["a_desk"])
    s = api.get("/hospital/settings", headers=desk).json()
    assert s["device_min_fps"] == 55 and s["change_cutoff_hours"] == 24 and s["patient_changes"] is True
    assert s["device_min_fps_options"] == [55, 56, 57, 58, 59]
    # Only the hospital admin changes them; values come from the offered lists.
    assert api.put("/hospital/settings", headers=desk, json={"change_cutoff_hours": 48}).status_code == 403
    assert api.put("/hospital/settings", headers=admin, json={"device_min_fps": 50}).status_code == 422
    assert api.put("/hospital/settings", headers=admin, json={"change_cutoff_hours": 5}).status_code == 422
    assert api.put("/hospital/settings", headers=admin, json={"time_zone": "Mars/Base"}).status_code == 422
    r = api.put(
        "/hospital/settings",
        headers=admin,
        json={"device_min_fps": 58, "change_cutoff_hours": 48, "time_zone": "America/New_York"},
    )
    assert (
        r.status_code == 200
        and r.json()["device_min_fps"] == 58
        and r.json()["time_zone"] == "America/New_York"
    )
    # The other hospital keeps the defaults.
    assert api.get("/hospital/settings", headers=hdr(t["b_tok"])).json()["device_min_fps"] == 55

    # The phones' pass level: 57 fps passed the platform minimum, not this hospital's 58.
    code = api.post("/hospital/device-codes", headers=admin, json={"label": "W1"}).json()["code"]
    body = {
        "enrollment_code": code,
        "model": "Pixel",
        "os_version": "16",
        "camera_check": {"effective_fps": 57},
    }
    r = api.post("/auth/device-register", json=body)
    assert r.status_code == 422 and r.json()["detail"] == {
        "code": "camera_check_failed",
        "min_fps": 58,
        "fps": 57,
    }
    body["camera_check"]["effective_fps"] = 58.5
    assert api.post("/auth/device-register", json=body).status_code == 201

    # Clinic hours: checked, kept per doctor.
    dr = _staff(api, t, "hours-dr@sunrise.example", "doctor")
    dr_id = api.get("/hospital/doctors", headers=desk).json()[0]["id"]
    bad = {"week": {"mon": [["13:00", "09:00"]]}}
    assert api.put(f"/hospital/doctor-hours/{dr_id}", headers=admin, json=bad).status_code == 422
    overlap = {"week": {"mon": [["09:00", "12:00"], ["11:00", "13:00"]]}}
    assert api.put(f"/hospital/doctor-hours/{dr_id}", headers=admin, json=overlap).status_code == 422
    assert api.put(f"/hospital/doctor-hours/{dr_id}", headers=desk, json={"week": {}}).status_code == 403
    assert (
        api.put(f"/hospital/doctor-hours/{dr_id}", headers=hdr(t["b_tok"]), json={"week": {}}).status_code
        == 404
    )
    hours = api.get("/hospital/doctor-hours", headers=dr).json()
    assert [(h["has_hours"], h["slot_minutes"]) for h in hours] == [(False, 15)]


def test_desk_moves_with_free_times(api, two_hospitals):
    t = two_hospitals
    api.put("/hospital/settings", headers=hdr(t["a_tok"]), json={"time_zone": "Asia/Kolkata"})
    desk, dr1, docs, ncid, ptok = _setup(api, t)
    rao, menon = docs["v13-rao@sunrise.example"], docs["v13-menon@sunrise.example"]
    at = _local(5, 10)
    appt = api.post(
        "/hospital/appointments", headers=desk, json={"ncid": ncid, "at": at.isoformat(), "doctor_id": rao}
    ).json()
    # Dr. Rao sends a home link (due the day before).
    r = api.post(f"/hospital/appointments/{appt['id']}/request", headers=dr1, json={})
    assert r.status_code == 201, r.text
    due = datetime.fromisoformat(r.json()[0]["due_at"])

    # Another patient fills Dr. Rao's 9:00 on day 6; Dr. Menon is on leave that day.
    other, _ = home_patient(api, t["a_desk"])
    api.post(
        "/hospital/appointments",
        headers=desk,
        json={"ncid": other, "at": _local(6, 9).isoformat(), "doctor_id": rao},
    )
    day6 = _local(6, 0).date().isoformat()
    api.put(
        f"/hospital/doctor-hours/{menon}",
        headers=hdr(t["a_tok"]),
        json={
            "department": "Neurology",
            "week": WEEK,
            "slot_minutes": 30,
            "leave": [{"from": day6, "to": day6}],
        },
    )
    av = api.get(f"/hospital/availability?date={day6}&appointment_id={appt['id']}", headers=desk).json()
    assert av["time_zone"] == "Asia/Kolkata"
    first, second = av["doctors"]
    assert first["doctor_id"] == rao and first["booked"] == 1
    assert "09:00" not in first["free"] and first["free"][0] == "09:30" and "13:00" not in first["free"]
    assert len(first["free"]) == 13  # 8 morning + 6 afternoon slots, minus the booked 9:00
    assert second["doctor_id"] == menon and second["on_leave"] and second["free"] == []
    assert first["slot_minutes"] == 30  # v31: the dashboard lists every slot, taken ones struck

    # v31 (canvas v28): free times per day for the month calendar's green dots.
    day5, day7 = _local(5, 0).date().isoformat(), _local(7, 0).date().isoformat()
    fd = api.get(f"/hospital/free-days?from={day5}&to={day7}&doctor_id={rao}", headers=desk).json()
    assert [d["date"] for d in fd["days"]] == [day5, day6, day7]
    assert fd["days"][1]["free"] == 13 and fd["days"][2]["free"] == 14
    # The appointment being moved does not take its own slot.
    fd2 = api.get(
        f"/hospital/free-days?from={day5}&to={day5}&doctor_id={rao}&appointment_id={appt['id']}", headers=desk
    ).json()
    assert fd2["days"][0]["free"] == fd["days"][0]["free"] + 1
    # All doctors: Dr. Menon is on leave on day 6.
    both = api.get(f"/hospital/free-days?from={day6}&to={day6}", headers=desk).json()
    assert both["days"][0]["free"] == 13
    far = (_local(70, 0)).date().isoformat()
    assert api.get(f"/hospital/free-days?from={day5}&to={far}", headers=desk).status_code == 422
    assert api.get(f"/hospital/free-days?from={day5}&to={day7}", headers=hdr(t["a_tok"])).status_code == 403

    # Move to day 7 at 11:30 with Dr. Menon: the link's due date moves by the same amount.
    new_at = _local(7, 11, 30)
    r = api.post(
        f"/hospital/appointments/{appt['id']}/move",
        headers=desk,
        json={"at": new_at.isoformat(), "doctor_id": menon, "reason": "doctor_unavailable"},
    )
    assert r.status_code == 200, r.text
    moved = r.json()
    assert datetime.fromisoformat(moved["at"]) == new_at and moved["doctor_id"] == menon
    assert datetime.fromisoformat(moved["moved_from"]) == at and moved["moved_from_doctor_name"]
    # v14 (decision 046): another doctor and nothing recorded yet: the link is withdrawn and the
    # new doctor confirms the tests (the earlier choice is kept for them).
    assert moved["requests"][0]["state"] == "cancelled" and moved["stage"] == "needs_tests"
    assert moved["suggested_tests"]["places"] == ["home"] and moved["suggested_tests"]["from_doctor_name"]
    assert due
    hist = api.get(f"/hospital/appointments/{appt['id']}/history", headers=desk).json()
    actions = [e["action"] for e in hist]
    assert "appointment_moved" in actions and "appointment_doctor_changed" in actions
    assert (
        next(e for e in hist if e["action"] == "appointment_moved")["details"]["reason"]
        == "doctor_unavailable"
    )
    # The patient sees it was moved by the hospital; a notice waits for the connector.
    pa = api.get("/patient/appointments", headers=ptok).json()["appointments"][0]
    assert pa["moved_by_hospital"] and pa["doctor_name"] and pa["moved_from_doctor_name"]
    _notices(1)

    # Not to the past, not with an unknown reason, not by a doctor without booking rights.
    past = {"at": _local(-1, 10).isoformat(), "reason": "other"}
    assert api.post(f"/hospital/appointments/{appt['id']}/move", headers=desk, json=past).json()[
        "detail"
    ] == {"code": "time_in_past"}
    odd = {"at": _local(8, 10).isoformat(), "reason": "whim"}
    assert api.post(f"/hospital/appointments/{appt['id']}/move", headers=desk, json=odd).status_code == 422
    ok = {"at": _local(8, 10).isoformat(), "reason": "other"}
    assert api.post(f"/hospital/appointments/{appt['id']}/move", headers=dr1, json=ok).status_code == 403
    assert (
        api.post(f"/hospital/appointments/{appt['id']}/move", headers=hdr(t["b_desk"]), json=ok).status_code
        == 404
    )


def _notices(n: int) -> None:
    from app.db import _factory
    from app.models import AppointmentNotice

    with _factory()() as db:
        assert db.query(AppointmentNotice).count() == n


def test_patient_asks_and_desk_answers(api, two_hospitals):
    t = two_hospitals
    api.put("/hospital/settings", headers=hdr(t["a_tok"]), json={"time_zone": "Asia/Kolkata"})
    desk, _, docs, ncid, ptok = _setup(api, t)
    rao, menon = docs["v13-rao@sunrise.example"], docs["v13-menon@sunrise.example"]
    a1 = api.post(
        "/hospital/appointments",
        headers=desk,
        json={"ncid": ncid, "at": _local(5, 10).isoformat(), "doctor_id": rao},
    ).json()
    soon = api.post(
        "/hospital/appointments",
        headers=desk,
        json={"ncid": ncid, "at": (datetime.now(UTC) + timedelta(hours=10)).isoformat(), "doctor_id": rao},
    ).json()
    out = api.get("/patient/appointments", headers=ptok).json()
    assert out["time_zone"] == "Asia/Kolkata" and out["max_days"] == 4 and out["cutoff_hours"] == 24
    by_id = {a["id"]: a for a in out["appointments"]}
    assert by_id[a1["id"]]["can_ask"] and not by_id[soon["id"]]["can_ask"]  # within 24 h
    # v14: exact times on preferred and alternative dates (2 + 2 dates, 2 times each by default).
    choices = [
        {"at": _local(7, 10).isoformat(), "rank": "preferred"},
        {"at": _local(7, 10, 30).isoformat(), "rank": "preferred"},
        {"at": _local(9, 11).isoformat(), "rank": "alternative"},
    ]
    ask = {"choices": choices, "reason": "unwell"}
    late = api.post(f"/patient/appointments/{soon['id']}/change-request", headers=ptok, json=ask)
    assert late.status_code == 409 and late.json()["detail"] == {"code": "too_late_to_change"}
    for bad in (
        {**ask, "choices": [{"at": _local(d, 10).isoformat(), "rank": "preferred"} for d in (6, 7, 8)]},
        {**ask, "choices": [{"at": _local(7, h).isoformat(), "rank": "preferred"} for h in (9, 10, 11)]},
        {**ask, "choices": [{"at": _local(-2, 10).isoformat(), "rank": "preferred"}]},
        {**ask, "choices": [{"at": _local(7, 10).isoformat(), "rank": "alternative"}]},
        {**ask, "reason": "my knee hurts"},
    ):
        assert (
            api.post(f"/patient/appointments/{a1['id']}/change-request", headers=ptok, json=bad).status_code
            == 422
        )
    r = api.post(f"/patient/appointments/{a1['id']}/change-request", headers=ptok, json=ask)
    assert r.status_code == 201 and r.json()["status"] == "open"
    again = api.post(f"/patient/appointments/{a1['id']}/change-request", headers=ptok, json=ask)
    assert again.json()["detail"] == {"code": "change_already_asked"}
    assert (
        api.post(f"/patient/appointments/{a1['id']}/change-request", headers=desk, json=ask).status_code
        == 403
    )

    # The desk sees it (the other hospital does not), with the open request on the appointment.
    reqs = api.get("/hospital/change-requests", headers=desk).json()
    assert [(x["ncid"], x["kind"], x["reason"], len(x["choices"])) for x in reqs] == [
        (ncid, "change", "unwell", 3)
    ]
    # Each time is checked now: Dr. Rao works 9-13 every day, so all three are free.
    assert [c["state"] for c in reqs[0]["choices"]] == ["free", "free", "free"]
    assert datetime.fromisoformat(reqs[0]["choices"][0]["at"]) == _local(7, 10)
    assert api.get("/hospital/change-requests", headers=hdr(t["b_desk"])).json() == []
    listed = {a["id"]: a for a in api.get("/hospital/appointments?days=14", headers=desk).json()}
    assert listed[a1["id"]]["change_request_id"] == reqs[0]["id"]

    # Withdraw, ask again, then the desk declines; the patient sees the answer.
    assert api.post(f"/patient/change-requests/{reqs[0]['id']}/withdraw", headers=ptok).status_code == 204
    assert api.get("/hospital/change-requests", headers=desk).json() == []
    r = api.post(f"/patient/appointments/{a1['id']}/change-request", headers=ptok, json=ask)
    cid = r.json()["id"]
    assert (
        api.post(
            f"/hospital/change-requests/{cid}/decline", headers=desk, json={"answer": "nope"}
        ).status_code
        == 422
    )
    r = api.post(f"/hospital/change-requests/{cid}/decline", headers=desk, json={"answer": "call_us"})
    assert r.status_code == 200 and r.json()["status"] == "declined"
    pa = {a["id"]: a for a in api.get("/patient/appointments", headers=ptok).json()["appointments"]}[a1["id"]]
    assert pa["change"]["status"] == "declined" and pa["change"]["answer"] == "call_us" and pa["can_ask"]
    _notices(1)

    # Asked a third time and accepted: moved to the patient's day with Dr. Menon.
    cid = api.post(f"/patient/appointments/{a1['id']}/change-request", headers=ptok, json=ask).json()["id"]
    new_at = _local(9, 10, 30)
    r = api.post(
        f"/hospital/appointments/{a1['id']}/move",
        headers=desk,
        json={
            "at": new_at.isoformat(),
            "doctor_id": menon,
            "reason": "patient_request",
            "change_request_id": cid,
            "notify": False,
        },
    )
    assert r.status_code == 200, r.text
    pa = {a["id"]: a for a in api.get("/patient/appointments", headers=ptok).json()["appointments"]}[a1["id"]]
    assert pa["change"]["status"] == "accepted" and not pa["moved_by_hospital"]
    assert datetime.fromisoformat(pa["at"]) == new_at
    _notices(1)  # notify was off
    # A request that is no longer open cannot be answered again.
    r = api.post(f"/hospital/change-requests/{cid}/decline", headers=desk, json={"answer": "keep"})
    assert r.json()["detail"] == {"code": "request_not_open"}

    # Turned off by the hospital admin: no more requests.
    api.put("/hospital/settings", headers=hdr(t["a_tok"]), json={"patient_changes": False})
    out = api.get("/patient/appointments", headers=ptok).json()["appointments"]
    assert not any(a["can_ask"] for a in out)
    r = api.post(f"/patient/appointments/{a1['id']}/change-request", headers=ptok, json=ask)
    assert r.json()["detail"] == {"code": "changes_off"}


def test_cancel_closes_request_and_fhir_keeps_desk_change(api, two_hospitals):
    t = two_hospitals
    desk, _, docs, ncid, ptok = _setup(api, t)
    rao = docs["v13-rao@sunrise.example"]
    a = api.post(
        "/hospital/appointments",
        headers=desk,
        json={"ncid": ncid, "at": _local(5, 10).isoformat(), "doctor_id": rao},
    ).json()
    api.post(
        f"/patient/appointments/{a['id']}/change-request",
        headers=ptok,
        json={"choices": [{"at": _local(7, 10).isoformat(), "rank": "preferred"}]},
    )
    api.put(f"/hospital/appointments/{a['id']}", headers=desk, json={"status": "cancelled"})
    assert api.get("/hospital/change-requests", headers=desk).json() == []
    [cancelled] = api.get("/patient/appointments", headers=ptok).json()["appointments"]
    assert (
        cancelled["status"] == "cancelled"
        and cancelled["cancelled_by"] == "staff"
        and not cancelled["can_cancel"]
    )

    # Booked in the hospital system: a desk move is kept when the same time arrives again, and
    # replaced when the hospital system's time changes.
    fhir_at = _local(10, 9)
    body = {"ncid": ncid, "at": fhir_at.isoformat(), "source": "fhir", "external_id": "Appointment/9"}
    f = api.post("/hospital/appointments", headers=desk, json=body).json()
    moved_to = _local(11, 15)
    api.post(
        f"/hospital/appointments/{f['id']}/move",
        headers=desk,
        json={"at": moved_to.isoformat(), "reason": "patient_called", "notify": False},
    )
    again = api.post("/hospital/appointments", headers=desk, json=body).json()
    assert datetime.fromisoformat(again["at"]) == moved_to
    changed = {**body, "at": _local(12, 9).isoformat()}
    assert datetime.fromisoformat(
        api.post("/hospital/appointments", headers=desk, json=changed).json()["at"]
    ) == _local(12, 9)


def test_moved_to_another_doctor_leaves_the_first_doctor_view_only(api, two_hospitals):
    """Decision 061: the first doctor keeps view-only access; the new doctor has full access."""
    from test_patient_app import _SECRETS
    from test_tenancy import staff_login

    t = two_hospitals
    desk, dr1, docs, ncid, _ = _setup(api, t)
    rao, menon = docs["v13-rao@sunrise.example"], docs["v13-menon@sunrise.example"]
    appt = api.post(
        "/hospital/appointments",
        headers=desk,
        json={"ncid": ncid, "at": _local(5, 10).isoformat(), "doctor_id": rao},
    ).json()
    mine = next(p for p in api.get("/hospital/patients", headers=dr1).json() if p["ncid"] == ncid)
    assert (mine["view_only"], mine["moved_to"]) == (False, None)
    r = api.post(
        f"/hospital/appointments/{appt['id']}/move",
        headers=desk,
        json={"at": _local(7, 11, 30).isoformat(), "doctor_id": menon, "reason": "doctor_unavailable"},
    )
    assert r.status_code == 200, r.text

    # Dr. Rao: still listed, view only, with where it went; reading works, changing does not.
    mine = next(p for p in api.get("/hospital/patients", headers=dr1).json() if p["ncid"] == ncid)
    assert mine["view_only"] is True and mine["moved_to"]
    h = api.get(f"/hospital/patients/{ncid}/history", headers=dr1)
    assert h.status_code == 200 and h.json()["view_only"] is True and h.json()["moved_to"]
    assert api.get(f"/hospital/appointments/{appt['id']}/history", headers=dr1).status_code == 200
    put = api.put(
        f"/hospital/patients/{ncid}/plan",
        headers=dr1,
        json={"tests": ["FT"], "every_days": 7, "med_state": "OFF"},
    )
    assert put.status_code == 403 and put.json()["detail"]["code"] == "moved_view_only"
    rr = api.post(f"/hospital/patients/{ncid}/rerecord", headers=dr1, json={"tests": []})
    assert rr.status_code == 403

    # Dr. Menon: full access.
    dr2 = hdr(
        staff_login(api, "v13-menon@sunrise.example", _SECRETS["v13-menon@sunrise.example"])["access_token"]
    )
    h2 = api.get(f"/hospital/patients/{ncid}/history", headers=dr2).json()
    assert (h2["view_only"], h2["moved_to"]) == (False, None)
