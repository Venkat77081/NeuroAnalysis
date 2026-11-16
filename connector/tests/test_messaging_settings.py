"""Decision 042: the hospital admin sets e-mail and SMS in the dashboard. Kept at the connector,
encrypted; passwords never come back; environment values win; the platform learns only the status."""

import pytest
from fake_smtp import FakeSmtp
from test_e2e import ctoken

from ncconnector.config import get_settings
from ncconnector.db import MessagingSettings, factory


@pytest.fixture
def smtp():
    s = FakeSmtp()
    yield s
    s.close()


def _site_status(env):
    from app.db import _factory
    from app.models import Site

    with _factory()() as db:
        return db.get(Site, env["site_id"]).messaging_status


def test_admin_sets_email_and_tests_it(connector, smtp):
    env, c = connector, connector["client"]
    admin = ctoken(env, env["admin_tok"])
    assert c.get("/v1/settings/messaging", headers=ctoken(env)).status_code == 403  # front desk
    v = c.get("/v1/settings/messaging", headers=admin).json()
    assert v["email"]["on"] is False and v["sms"]["values"]["provider"] == "off"

    r = c.put(
        "/v1/settings/messaging",
        headers=admin,
        json={
            "email": {
                "host": "127.0.0.1",
                "port": smtp.port,
                "security": "none",
                "username": "nc-mailer",
                "password": "s3cret-app-password",
                "from": "no-reply@sunrise.example",
                "from_name": "Sunrise Neuro Clinic",
            }
        },
    )
    assert r.status_code == 200, r.text
    v = r.json()
    assert v["email"]["on"] is True and v["email"]["values"]["password"] is True
    assert "s3cret" not in r.text
    with factory()() as db:
        assert "s3cret" not in db.get(MessagingSettings, "default").sealed  # encrypted at rest

    r = c.post(
        "/v1/settings/messaging/test", headers=admin, json={"channel": "email", "to": "it@sunrise.example"}
    )
    assert r.status_code == 200, r.text
    assert smtp.logins == [("nc-mailer", "s3cret-app-password")]
    assert "test" in smtp.messages[-1]["Subject"].lower()
    assert _site_status(env)["email"] == "working" and _site_status(env)["sms"] == "off"

    # Saving without the password keeps it; the activity log names fields, never values.
    c.put("/v1/settings/messaging", headers=admin, json={"email": {"from_name": "Sunrise"}})
    assert c.get("/v1/settings/messaging", headers=admin).json()["email"]["values"]["password"] is True
    log = c.get("/v1/activity", headers=admin).text
    assert "messaging_settings_changed" in log and "s3cret" not in log


def test_failing_sms_and_env_wins(connector, monkeypatch):
    env, c = connector, connector["client"]
    admin = ctoken(env, env["admin_tok"])
    r = c.put(
        "/v1/settings/messaging",
        headers=admin,
        json={"sms": {"provider": "http", "http_url": "https://127.0.0.1:9/sms", "http_token": "tok-123"}},
    )
    assert r.status_code == 200 and r.json()["sms"]["values"]["http_token"] is True
    r = c.post("/v1/settings/messaging/test", headers=admin, json={"channel": "sms", "to": "+919812345678"})
    assert r.status_code == 502 and r.json()["detail"]["code"] == "sms_not_sent"
    assert _site_status(env)["sms"] == "failing"
    bad = c.put("/v1/settings/messaging", headers=admin, json={"sms": {"dlt_template_ids": "nope"}})
    assert bad.status_code == 422

    # IT set the SMTP host in the environment: shown as set by IT, the dashboard cannot change it.
    monkeypatch.setattr(get_settings(), "smtp_host", "mail.hospital.example")
    c.put("/v1/settings/messaging", headers=admin, json={"email": {"host": "other.example"}})
    v = c.get("/v1/settings/messaging", headers=admin).json()
    assert v["email"]["values"]["host"] == "mail.hospital.example"
    assert "host" in v["email"]["set_by_it"]
