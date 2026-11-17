"""Decision 044: NeuroCapture stores no videos. A hospital records only after it connects its own
S3 bucket or Azure container; until then sessions and takes are refused and phones are told."""

from test_tenancy import (  # noqa: F401 - fixtures
    _clean,
    hdr,
    platform,
    two_hospitals,
)
from test_upload_flow import SESSION, auth, login, register


def test_no_recording_until_the_hospital_connects_storage(api, site, monkeypatch):
    from app.config import get_settings
    from app.db import _factory
    from app.models import Site

    monkeypatch.setattr(get_settings(), "dev_storage", False)  # production
    with _factory()() as db:
        db.get(Site, site["site_id"]).storage_kind = "none"
        db.commit()
    dev = register(api)
    op = login(api, dev).json()
    r = api.get("/sessions/can-record", headers=auth(op))
    assert r.json() == {"can_record": False, "reason": "storage_not_connected"}
    started = api.post("/sessions", json=SESSION, headers=auth(op))
    assert started.status_code == 409 and started.json()["detail"]["code"] == "storage_not_connected"

    # Connected but its last test failed: phones are told, recording waits.
    with _factory()() as db:
        s = db.get(Site, site["site_id"])
        s.storage_kind, s.storage_config, s.storage_check = (
            "s3",
            {"bucket": "b", "prefix": ""},
            {"upload": "fail"},
        )
        db.commit()
    assert api.get("/sessions/can-record", headers=auth(op)).json()["reason"] == "storage_failing"


def test_development_storage_only_on_test_servers(api, two_hospitals, monkeypatch):
    from test_tenancy import hdr

    from app.config import get_settings

    t = two_hospitals
    st = api.get("/hospital/storage", headers=hdr(t["a_tok"])).json()
    assert st["kind"] == "dev" and st["can_record"] and "dev" in st["offered"]
    assert "managed" not in st["offered"]
    settings = api.get("/platform/settings", headers=hdr(t["platform"])).json()
    assert settings["storage_offered"][0] == "s3" and settings["dev_storage"] is True

    monkeypatch.setattr(get_settings(), "dev_storage", False)
    r = api.put("/hospital/storage", headers=hdr(t["a_tok"]), json={"kind": "dev"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "dev_storage_off"
    assert api.put("/hospital/storage", headers=hdr(t["a_tok"]), json={"kind": "managed"}).status_code == 422
    offered = api.get("/platform/settings", headers=hdr(t["platform"])).json()["storage_offered"]
    assert offered == (["s3", "azure"] if get_settings().azure_client_id else ["s3"])
