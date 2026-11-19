"""v31 (decision 054): each test's take length is set by the hospital (Settings) from the
lengths config/tests allows; a doctor may pick another per request; the phones get it."""

from datetime import UTC, datetime, timedelta

from test_clinic_consent import _queue
from test_clinic_consent import _setup as _clinic_setup
from test_patient_app import _staff, home_patient
from test_tenancy import (  # noqa: F401 - fixtures
    _clean,
    hdr,
    platform,
    two_hospitals,
)


def test_hospital_and_doctor_lengths(api, two_hospitals):
    t = two_hospitals
    admin, desk = hdr(t["a_tok"]), hdr(t["a_desk"])
    s = api.get("/hospital/settings", headers=desk).json()
    assert s["test_durations"] == {"FA": 15, "FR": 15, "FT": 15, "FTF": 15, "SAW": 45}
    assert s["test_duration_options"]["FT"] == [15, 20, 30]
    assert s["test_duration_options"]["SAW"] == [45, 60, 90]
    # Never below the biomarker registry's minimum, never a length not offered.
    r = api.put("/hospital/settings", headers=admin, json={"test_durations": {"FT": 10}})
    assert r.status_code == 422 and r.json()["detail"] == {"code": "duration_not_offered", "test": "FT"}
    assert (
        api.put("/hospital/settings", headers=admin, json={"test_durations": {"XX": 15}}).status_code == 422
    )
    assert api.put("/hospital/settings", headers=desk, json={"test_durations": {"FT": 20}}).status_code == 403
    r = api.put("/hospital/settings", headers=admin, json={"test_durations": {"FT": 20, "SAW": 60}})
    assert r.status_code == 200, r.text
    assert r.json()["test_durations"] == {"FA": 15, "FR": 15, "FT": 20, "FTF": 15, "SAW": 60}

    # A doctor's request: the hospital's lengths unless the doctor picks another for a test.
    dr = _staff(api, t, "len-dr@sunrise.example", "doctor")
    dr_id = next(
        d["id"]
        for d in api.get("/hospital/doctors", headers=desk).json()
        if d["email"] == "len-dr@sunrise.example"
    )
    ncid, acc = home_patient(api, t["a_desk"])
    at = (datetime.now(UTC) + timedelta(days=4)).replace(microsecond=0)
    a = api.post(
        "/hospital/appointments", headers=desk, json={"ncid": ncid, "at": at.isoformat(), "doctor_id": dr_id}
    )
    a = a.json()
    body = {"tests": ["FT", "FR", "SAW"], "durations": {"FR": 30}}
    bad = api.post(
        f"/hospital/appointments/{a['id']}/request", headers=dr, json={**body, "durations": {"FR": 25}}
    )
    assert bad.status_code == 422 and bad.json()["detail"]["test"] == "FR"
    r = api.post(f"/hospital/appointments/{a['id']}/request", headers=dr, json=body)
    assert r.status_code == 201, r.text
    assert r.json()[0]["durations"] == {"FT": 20, "FR": 30, "SAW": 60}
    # The patient's app gets the same lengths with the record link.
    mine = api.get("/patient/requests", headers=hdr(acc["tokens"]["access_token"])).json()
    assert mine[0]["durations"] == {"FT": 20, "FR": 30, "SAW": 60}
    # Later changes to Settings do not change a request already sent.
    api.put("/hospital/settings", headers=admin, json={"test_durations": {"FT": 30}})
    mine = api.get("/patient/requests", headers=hdr(acc["tokens"]["access_token"])).json()
    assert mine[0]["durations"]["FT"] == 20


def test_clinic_queue_carries_lengths(api, two_hospitals):
    t = two_hospitals
    ncid, _walkin, _reqs, _ptok, otok = _clinic_setup(api, t)
    q = _queue(api, otok)[ncid]
    assert q["durations"] == {code: (45 if code == "SAW" else 15) for code in q["tests"]}
