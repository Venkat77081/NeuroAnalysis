"""v29 (decision 052): the connector's heartbeat reaches the platform, which counts it per hour."""

from ncconnector.health import heartbeat


def hdr(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}"}


def test_heartbeat_is_counted_by_the_platform(connector):
    api, admin = connector["platform"], connector["admin_tok"]
    before = api.get("/hospital/connector/history", headers=hdr(admin)).json()
    heartbeat()
    heartbeat()
    after = api.get("/hospital/connector/history", headers=hdr(admin)).json()
    assert after["online"] and after["last_seen_at"]
    assert after["hours"][-1]["pings"] - before["hours"][-1]["pings"] == 2
