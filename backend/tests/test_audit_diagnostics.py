"""M9: session outcomes become audit events; crash reports are stored for admins only."""

from test_upload_flow import SESSION, auth, login, register

from app.db import _factory
from app.models import AuditEvent

CRASH = {
    "kind": "crash",
    "report": {
        "source": "js",
        "at": "2026-11-14T10:00:00Z",
        "app_version": "0.3.0",
        "plugin_version": "0.9.0",
        "platform": "android",
        "error": "TypeError",
        "message": "x is undefined",
        "stack": ["at finish (CameraStage.tsx:210)"],
        "screen": "test.review",
    },
}


def test_session_outcomes_are_audited(api, site):
    dev = register(api)
    op = login(api, dev).json()
    sid = api.post("/sessions", json=SESSION, headers=auth(op)).json()["id"]
    body = {
        "ended_at": "2026-11-14T10:20:00Z",
        "aborted": {"reason": "time_constraint"},
        "outcomes": [
            {"test_code": "FT", "status": "accepted", "client_take_id": "tk-1"},
            {"test_code": "FTF", "status": "kept", "reason": "patient_fatigue", "client_take_id": "tk-2"},
            {
                "test_code": "FR",
                "status": "skipped",
                "reason": "patient_unable",
                "at": "2026-11-14T10:10:00Z",
            },
            {"test_code": "SAW", "status": "pending"},
        ],
    }
    assert api.post(f"/sessions/{sid}/close", json=body, headers=auth(op)).status_code == 200
    with _factory()() as db:
        ev = {e.action: e.details for e in db.query(AuditEvent).filter(AuditEvent.target_id == sid)}
    assert ev["test_skipped"]["test_code"] == "FR" and ev["test_skipped"]["reason"] == "patient_unable"
    assert ev["take_kept"]["reason"] == "patient_fatigue"
    assert ev["session_closed"] == {
        "aborted": "time_constraint",
        "outcomes": {"accepted": 1, "kept": 1, "skipped": 1, "pending": 1},
    }
    # Free text never reaches the server through outcomes.
    bad = {**body, "outcomes": [{"test_code": "FT", "status": "skipped", "reason": "Mr Sharma left"}]}
    assert api.post(f"/sessions/{sid}/close", json=bad, headers=auth(op)).status_code == 422


def test_crash_reports_stored_and_listed_for_admins(api, site):
    dev = register(api)
    op = login(api, dev).json()
    ad = login(api, dev, "AD-01", "9999").json()
    assert api.post("/diagnostics", json=CRASH, headers=auth(op)).status_code == 201
    too_long = {**CRASH, "report": {**CRASH["report"], "message": "x" * 600}}
    assert api.post("/diagnostics", json=too_long, headers=auth(op)).status_code == 422
    assert api.get("/diagnostics", headers=auth(op)).status_code == 403
    rows = api.get("/diagnostics", headers=auth(ad)).json()
    assert len(rows) == 1 and rows[0]["error"] == "TypeError" and rows[0]["screen"] == "test.review"
