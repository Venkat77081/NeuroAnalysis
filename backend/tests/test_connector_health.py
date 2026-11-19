"""v29 (decision 052): the connector's check-ins, counted per hour, for the dashboards' 24-hour
strip and "offline since"."""

from datetime import UTC, datetime, timedelta

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from test_tenancy import _clean, hdr, onboard, platform, sign_up  # noqa: F401 - fixtures

from app.connector_health import history, hour_of, is_online, record_ping
from app.models import ConnectorPing, Site
from app.policy import policy
from app.signing import public_pem, sign_headers


@pytest.fixture
def hosp(api, platform):  # noqa: F811
    site = onboard(api, platform, "Sunrise Neuro Clinic", "admin@sunrise.example")
    tok, _ = sign_up(api, "admin@sunrise.example")
    key = Ed25519PrivateKey.generate()
    r = api.put(
        "/hospital/connector",
        headers=hdr(tok),
        json={"url": "https://c.example", "public_key_pem": public_pem(key.public_key())},
    )
    assert r.status_code == 200
    return site, tok, key, platform


def beat(api, site, key):
    return api.post(
        "/connector/v1/heartbeat",
        headers=sign_headers(key, site, "POST", "/connector/v1/heartbeat", b""),
        content=b"",
    )


def test_heartbeat_counts_and_shows_online(api, hosp):
    site, tok, key, ptok = hosp
    h0 = api.get("/hospital/connector/history", headers=hdr(tok)).json()
    cfg = policy()["connectorHealth"]
    assert h0["registered"] and not h0["online"] and h0["last_seen_at"] is None
    assert len(h0["hours"]) == cfg["historyHours"] and all(x["pings"] == 0 for x in h0["hours"])

    assert beat(api, site, key).status_code == 204
    assert beat(api, site, key).status_code == 204
    h = api.get("/hospital/connector/history", headers=hdr(tok)).json()
    assert h["online"] and h["offline_since"] is None and h["last_seen_at"]
    assert h["hours"][-1]["pings"] == 2 and h["heartbeat_seconds"] == cfg["heartbeatSeconds"]

    # The platform admin sees the same, and the hospital list says the connector is online.
    p = api.get(f"/platform/hospitals/{site}/connector-history", headers=hdr(ptok)).json()
    assert p["hours"][-1]["pings"] == 2 and p["online"]
    row = next(x for x in api.get("/platform/hospitals", headers=hdr(ptok)).json() if x["id"] == site)
    assert row["connector_online"] is True and row["connector_last_seen_at"]


def test_unsigned_heartbeat_is_refused(api, hosp):
    site, _, _, _ = hosp
    assert api.post("/connector/v1/heartbeat", headers={"x-nc-key": site}).status_code == 401
    other = Ed25519PrivateKey.generate()  # not the hospital's key
    assert beat(api, site, other).status_code == 401


def test_offline_after_the_configured_minutes(api, hosp):
    from app.db import _factory

    site_id, _, _, _ = hosp
    minutes = policy()["connectorHealth"]["offlineAfterMinutes"]
    seen = datetime(2026, 11, 19, 8, 40, tzinfo=UTC)
    with _factory()() as db:
        record_ping(db, site_id, seen)
        site = db.get(Site, site_id)
        on = history(db, site, seen + timedelta(minutes=minutes - 1))
        off = history(db, site, seen + timedelta(hours=2, minutes=28))
    assert on.online and on.offline_since is None
    assert not off.online and off.offline_since == seen
    # One bar per hour, oldest first; 08:00 has the check-in, the hours after it none.
    by = {h.start: h.pings for h in off.hours}
    assert by[hour_of(seen)] == 1 and by[hour_of(seen) + timedelta(hours=1)] == 0
    assert not is_online(None)


def test_old_counts_are_dropped(api, hosp):
    from sqlalchemy import select

    from app.db import _factory

    site_id, _, _, _ = hosp
    keep = policy()["connectorHealth"]["keepDays"]
    now = datetime(2026, 11, 19, 9, 5, tzinfo=UTC)
    with _factory()() as db:
        record_ping(db, site_id, now - timedelta(days=keep + 2))
        record_ping(db, site_id, now - timedelta(days=1))
        record_ping(db, site_id, now)  # a new hour: prunes the oldest
        rows = db.scalars(select(ConnectorPing).where(ConnectorPing.site_id == site_id))
        hours = sorted(r.hour for r in rows)
    assert hours == [hour_of(now - timedelta(days=1)), hour_of(now)]


def test_hospital_list_carries_card_details(api, hosp):
    """v30 (decision 053): set-up steps done, storage kind and the admin's e-mail for the card."""
    site, _, _, ptok = hosp
    row = next(x for x in api.get("/platform/hospitals", headers=hdr(ptok)).json() if x["id"] == site)
    assert row["setup_total"] == 6
    # The same count as the set-up panel's steps.
    st = api.get(f"/platform/hospitals/{site}/setup", headers=hdr(ptok)).json()
    check = st["connector_check"] or {}
    steps = [
        st["admin_accepted"],
        st["connector_registered"],
        bool(check) and all(v == "pass" for v in check.values()),
        st["take_key"],
        st["can_record"],
        st["doctors"] > 0,
    ]
    assert row["setup_done"] == sum(steps) and row["connector_registered"] is True
    assert row["admin_email"] == "admin@sunrise.example" and row["messaging"] is None
