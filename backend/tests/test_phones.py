"""Decision 062: the phone check reports memory and storage; the platform and the hospital see
every phone's numbers. Patients appear by NCID only; the platform never gets a name or MRN."""

from test_tenancy import (  # noqa: F401 - fixtures
    _clean,
    hdr,
    invite_token,
    platform,
    two_hospitals,
)

GIB = 1 << 30
PHONE = {
    "brand": "samsung",
    "manufacturer": "samsung",
    "video_width": 1920,
    "video_height": 1080,
    "video_bytes_per_s": 3.6e6,
    "ram_total_bytes": int(5.6 * GIB),  # a "6 GB" phone, as Android reports it
    "ram_free_bytes": int(2.9e9),
    "ram_low": False,
    "storage_free_bytes": int(18.4e9),
    "storage_total_bytes": 128 * 10**9,
}


def _join(api, t, check):
    inv = api.post("/hospital/patients/invite", headers=hdr(t["a_desk"]), json={"channel": "print"}).json()
    r = api.post(
        "/patient/invite/accept",
        json={
            "token": invite_token(inv["invite_link"]),
            "pin": "2580",
            "model": "Galaxy A54",
            "os_version": "14",
            "camera_check": check,
        },
    )
    return inv["ncid"], r


def test_join_keeps_the_phone_numbers_and_both_lists_show_them(api, two_hospitals):
    t = two_hospitals
    ncid, r = _join(api, t, {"effective_fps": 59.8, **PHONE})
    assert r.status_code == 201, r.text
    rows = api.get("/hospital/devices?kind=patient", headers=hdr(t["a_tok"])).json()
    (row,) = [x for x in rows if x["ncid"] == ncid]
    p = row["phone"]
    assert (p["brand"], p["video_width"], p["video_height"], p["ram_total_gb"]) == ("samsung", 1920, 1080, 6)
    assert p["storage_free_bytes"] == int(18.4e9) and p["status"] == "ready"
    assert row["check_fps"] == 59.8

    phones = api.get("/platform/phones", headers=hdr(t["platform"])).json()
    (pp,) = [x for x in phones if x["ncid"] == ncid]
    assert pp["hospital"] == "Sunrise Neuro Clinic" and pp["model"] == "Galaxy A54"
    assert pp["phone"]["ram_total_gb"] == 6
    # Only the platform admin, and never anything that names the patient.
    assert api.get("/platform/phones", headers=hdr(t["a_tok"])).status_code == 403
    assert all(set(x) >= {"ncid", "label"} and "mrn" not in x and "name" not in x for x in phones)


def test_too_little_memory_is_not_suitable_and_the_invite_still_works(api, two_hospitals):
    t = two_hospitals
    small = {**PHONE, "ram_total_bytes": int(1.8 * GIB)}  # a "2 GB" phone
    _, r = _join(api, t, {"effective_fps": 60, **small})
    assert r.status_code == 422
    assert r.json()["detail"] == {
        "code": "camera_check_failed",
        "reason": "memory",
        "min_memory_gb": 3,
        "memory_gb": 2,
    }
    # A "3 GB" phone (about 2.8 GiB reported) may join; it shows as low on memory.
    ncid, r = _join(api, t, {"effective_fps": 60, **PHONE, "ram_total_bytes": int(2.8 * GIB)})
    assert r.status_code == 201, r.text
    rows = api.get("/hospital/devices?kind=patient", headers=hdr(t["a_tok"])).json()
    (row,) = [x for x in rows if x["ncid"] == ncid]
    assert row["phone"]["ram_total_gb"] == 3 and row["phone"]["status"] == "memory_low"


def test_the_phone_reports_before_each_visit(api, two_hospitals):
    t = two_hospitals
    ncid, r = _join(api, t, {"effective_fps": 59.8, **PHONE})
    ptok = hdr(r.json()["tokens"]["access_token"])
    # Before a visit: little storage left (no fps: the camera did not run).
    out = api.post(
        "/devices/me/phone", headers=ptok, json={"kind": "visit", "storage_free_bytes": int(1.6e9)}
    ).json()
    assert out["status"] == "cannot_record" and out["storage_free_bytes"] == int(1.6e9)
    assert out["brand"] == "samsung"  # earlier numbers are kept
    out = api.post(
        "/devices/me/phone", headers=ptok, json={"kind": "visit", "storage_free_bytes": int(2.5e9)}
    ).json()
    assert out["status"] == "storage_low"
    out = api.post(
        "/devices/me/phone",
        headers=ptok,
        json={"kind": "visit", "storage_free_bytes": int(9e9), "ram_low": True},
    ).json()
    assert out["status"] == "memory_low"
    # The phone check again from the menu: a slower camera now.
    out = api.post(
        "/devices/me/phone",
        headers=ptok,
        json={"kind": "check", "effective_fps": 57.0, "ram_low": False, "ram_free_bytes": int(2e9)},
    ).json()
    assert out["status"] == "camera_slow"
    rows = api.get("/hospital/devices?kind=patient", headers=hdr(t["a_tok"])).json()
    (row,) = [x for x in rows if x["ncid"] == ncid]
    assert row["check_fps"] == 57.0
    # Staff cannot report for a phone.
    assert api.post("/devices/me/phone", headers=hdr(t["a_tok"]), json={}).status_code == 403


def test_the_hand_sign_try_out_is_kept(api, two_hospitals):
    """v36 (decision 063): the try-out's result and the tracking rate, per phone."""
    t = two_hospitals
    ncid, r = _join(api, t, {"effective_fps": 59.8, **PHONE, "start_sign": "works", "tracking_hz": 24.3})
    assert r.status_code == 201, r.text
    rows = api.get("/hospital/devices?kind=patient", headers=hdr(t["a_tok"])).json()
    (row,) = [x for x in rows if x["ncid"] == ncid]
    assert (row["phone"]["start_sign"], row["phone"]["tracking_hz"]) == ("works", 24.3)
    ptok = hdr(r.json()["tokens"]["access_token"])
    out = api.post("/devices/me/phone", headers=ptok, json={"kind": "check", "start_sign": "too_slow"}).json()
    assert out["start_sign"] == "too_slow" and out["tracking_hz"] == 24.3
    bad = api.post("/devices/me/phone", headers=ptok, json={"kind": "check", "start_sign": "maybe"})
    assert bad.status_code == 422
