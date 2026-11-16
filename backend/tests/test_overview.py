"""v10 Overview (decision 042): counts and one chart per role; counts only on the platform."""

from datetime import UTC, datetime, timedelta

from test_patient_app import _staff, home_patient
from test_tenancy import (  # noqa: F401 - fixtures
    _clean,
    hdr,
    platform,
    two_hospitals,
)


def _tiles(body):
    return {t["key"]: t for t in body["tiles"]}


def test_overview_for_each_role(api, two_hospitals):
    t = two_hospitals
    desk = hdr(t["a_desk"])
    dr = _staff(api, t, "ov-dr@sunrise.example", "doctor")
    dr_id = api.get("/hospital/doctors", headers=desk).json()[0]["id"]
    ncid, _ = home_patient(api, t["a_desk"])
    soon = (datetime.now(UTC) + timedelta(days=2)).replace(microsecond=0)
    api.post(
        "/hospital/appointments",
        headers=desk,
        json={"ncid": ncid, "at": soon.isoformat(), "doctor_id": dr_id},
    )
    api.post(
        "/hospital/appointments",
        headers=desk,
        json={"ncid": ncid, "at": (soon + timedelta(days=1)).isoformat()},
    )

    # Platform admin: hospitals and counts, never a patient.
    r = api.get("/overview?period=4w", headers=hdr(t["platform"]))
    assert r.status_code == 200, r.text
    body = r.json()
    tiles = _tiles(body)
    assert tiles["hospitals"]["value"] == 2 and tiles["hospitalsLeft"]["value"] == 0
    assert tiles["patients"]["value"] >= 1
    assert body["unit"] == "week" and 4 <= len(body["series"]) <= 6
    assert {i["name"] for i in body["items"]} == {"Sunrise Neuro Clinic", "Lakeview Hospital"}
    assert ncid not in r.text
    assert len(api.get("/overview?period=1y", headers=hdr(t["platform"])).json()["series"]) >= 52
    assert api.get("/overview?period=2y", headers=hdr(t["platform"])).status_code == 422

    # Hospital admin: own hospital, set-up and health list (e-mail / SMS unknown until reported).
    body = api.get("/overview", headers=hdr(t["a_tok"])).json()
    tiles = _tiles(body)
    assert body["role"] == "hospital_admin"
    assert tiles["staff"]["detail"]["doctors"] == 1 and tiles["staff"]["detail"]["desk"] == 1
    assert {i["key"]: i["status"] for i in body["items"]}["sms"] == "unknown"

    # Front desk: one appointment needs a doctor, one waits for the doctor's tests.
    body = api.get("/overview?tz=Asia/Kolkata", headers=desk).json()
    tiles = _tiles(body)
    assert body["unit"] == "day" and len(body["series"]) == 14
    assert sum(p["count"] for p in body["series"]) == 2
    assert tiles["needDoctor"]["value"] == 1 and tiles["needDoctor"]["tone"] == "todo"
    assert tiles["waitingTests"]["value"] == 1
    assert api.get("/overview?tz=Not/AZone", headers=desk).status_code == 200

    # Doctor: their own patients and work.
    tiles = _tiles(api.get("/overview", headers=dr).json())
    assert tiles["chooseTests"]["value"] == 1 and tiles["upcoming"]["value"] == 1
    assert tiles["myPatients"]["value"] == 1 and tiles["onTime"]["value"] is None

    # Other hospital sees none of it.
    b_tiles = _tiles(api.get("/overview", headers=hdr(t["b_tok"])).json())
    assert b_tiles["patients"]["value"] == 0


def test_connector_reports_messaging_status(api, two_hospitals):
    from app.db import _factory
    from app.models import Site

    t = two_hospitals
    with _factory()() as db:
        db.get(Site, t["a"]).messaging_status = {"email": "working", "sms": "off"}
        db.commit()
    items = {i["key"]: i["status"] for i in api.get("/overview", headers=hdr(t["a_tok"])).json()["items"]}
    assert items["email"] == "working" and items["sms"] == "off"
