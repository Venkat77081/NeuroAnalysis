"""Real message delivery: patient invites over SMTP (with the QR code attached), SMS through Twilio,
Amazon SNS or an HTTP gateway, phone-number formatting, failures and the start-up check."""

import json
from types import SimpleNamespace

import pytest
from fake_smtp import FakeSmtp
from test_e2e import ctoken

from ncconnector import delivery
from ncconnector.config import Settings, get_settings
from ncconnector.delivery import DeliveryError, check_config, e164, send_sms_via


@pytest.fixture
def smtp():
    s = FakeSmtp()
    yield s
    s.close()


def use_smtp(monkeypatch, port: int) -> None:
    cs = get_settings()
    for k, v in {
        "email_provider": "smtp",
        "smtp_host": "127.0.0.1",
        "smtp_port": port,
        "smtp_security": "none",
        "smtp_username": "nc-mailer",
        "smtp_password": "app-password",
        "mail_from": "no-reply@sunrise.example",
        "mail_from_name": "Sunrise Neuro Clinic",
        "smtp_timeout_s": 3.0,
    }.items():
        monkeypatch.setattr(cs, k, v)


def test_patient_invite_over_smtp_with_qr(connector, smtp, monkeypatch):
    use_smtp(monkeypatch, smtp.port)
    c = connector["client"]
    r = c.post("/v1/invites", headers=ctoken(connector), json={"mrns": ["00012388"], "channel": "email"})
    assert r.status_code == 200 and r.json()[0]["result"] == "sent", r.text
    assert smtp.logins == [("nc-mailer", "app-password")]
    assert smtp.envelopes == [("no-reply@sunrise.example", ["asha.t@example.org"])]
    msg = smtp.messages[0]
    assert msg["From"] == "Sunrise Neuro Clinic <no-reply@sunrise.example>"
    assert "Sunrise Neuro Clinic" in msg["Subject"] and msg["Message-ID"]
    parts = {p.get_filename(): p for p in msg.walk() if p.get_filename()}
    assert parts["invite-qr.png"].get_payload(decode=True)[:8] == b"\x89PNG\r\n\x1a\n"
    body = (
        next(p for p in msg.walk() if p.get_content_type() == "text/plain").get_payload(decode=True).decode()
    )
    assert "neurocapture://invite?t=" in body


def test_mail_server_down_gives_not_delivered(connector, monkeypatch):
    dead = FakeSmtp()
    port = dead.port
    dead.close()  # nothing listens on this port now
    use_smtp(monkeypatch, port)
    c = connector["client"]
    r = c.post("/v1/invites", headers=ctoken(connector), json={"mrns": ["00012388"], "channel": "email"})
    res = r.json()[0]
    assert r.status_code == 200 and res["result"] == "not_delivered" and res["error"] == "email_not_sent"
    assert res["ncid"].startswith("nc_")  # the invite exists: print the QR code instead
    printed = c.post(
        "/v1/invites", headers=ctoken(connector), json={"mrns": ["00012388"], "channel": "print"}
    )
    assert printed.json()[0]["result"] == "printed"
    log = c.get("/v1/activity", headers=ctoken(connector, connector["admin_tok"])).json()
    assert any(e["action"] == "invite_not_delivered" for e in log)


def cfg(**over):
    base = {k: v.default for k, v in Settings.model_fields.items()}
    return SimpleNamespace(**{**base, **over})


@pytest.mark.parametrize(
    ("raw", "out"),
    [
        ("98765 43210", "+919876543210"),
        ("098765-43210", "+919876543210"),
        ("+91 98765 43210", "+919876543210"),
        ("919876543210", "+919876543210"),
        ("0044 20 7946 0958", "+442079460958"),
    ],
)
def test_phone_numbers_become_e164(raw, out):
    assert e164(cfg(), raw) == out


def test_bad_phone_number():
    with pytest.raises(DeliveryError) as e:
        e164(cfg(), "12")
    assert e.value.code == "bad_phone"


class Resp:
    def __init__(self, code: int) -> None:
        self.status_code = code


def test_twilio(monkeypatch):
    calls = []
    monkeypatch.setattr(delivery, "http_post", lambda url, **kw: calls.append((url, kw)) or Resp(201))
    c = cfg(sms_provider="twilio", twilio_account_sid="AC1", twilio_auth_token="tok", sms_from="+15550001111")  # noqa: S106
    send_sms_via(c, "98765 43210", "Join Sunrise", "patientInviteSms")
    url, kw = calls[0]
    assert url == "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json"
    assert kw["data"] == {"To": "+919876543210", "Body": "Join Sunrise", "From": "+15550001111"}
    assert kw["auth"] == ("AC1", "tok")
    monkeypatch.setattr(delivery, "http_post", lambda url, **kw: Resp(400))
    with pytest.raises(DeliveryError) as e:
        send_sms_via(c, "9876543210", "x", "reminderSms")
    assert e.value.code == "sms_not_sent"


def test_http_gateway_with_dlt_ids(monkeypatch):
    calls = []
    monkeypatch.setattr(delivery, "http_post", lambda url, **kw: calls.append((url, kw)) or Resp(200))
    c = cfg(
        sms_provider="http",
        sms_http_url="https://sms-adapter.hospital.example/send",
        sms_http_token="secret",  # noqa: S106 - test value
        sms_from="SNRISE",
        sms_dlt_entity_id="1201",
        sms_dlt_template_ids=json.dumps({"reminderSms": "1207"}),
    )
    send_sms_via(c, "9876543210", "Please record", "reminderSms")
    url, kw = calls[0]
    assert kw["headers"] == {"Authorization": "Bearer secret"}
    assert kw["json"] == {
        "to": "+919876543210",
        "body": "Please record",
        "template": "reminderSms",
        "dlt_template_id": "1207",
        "dlt_entity_id": "1201",
        "sender": "SNRISE",
    }

    def boom(url, **kw):
        raise OSError("down")

    monkeypatch.setattr(delivery, "http_post", boom)
    with pytest.raises(DeliveryError) as e:
        send_sms_via(c, "9876543210", "x", "reminderSms")
    assert e.value.code == "sms_not_sent"


def test_amazon_sns(monkeypatch):
    from moto import mock_aws

    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")
    with mock_aws():
        from moto.core import DEFAULT_ACCOUNT_ID
        from moto.sns.models import sns_backends

        c = cfg(
            sms_provider="sns",
            sms_from="SNRISE",
            sms_dlt_entity_id="1201",
            sms_dlt_template_ids='{"patientInviteSms": "1207"}',
        )
        send_sms_via(c, "9876543210", "Join Sunrise", "patientInviteSms")
        sent = sns_backends[DEFAULT_ACCOUNT_ID]["ap-south-1"].sms_messages
        assert list(sent.values()) == [("+919876543210", "Join Sunrise")]


def test_start_up_check():
    check_config(cfg())  # dummy: fine
    check_config(cfg(email_provider="smtp", smtp_host="smtp.example", mail_from="a@b.example"))
    with pytest.raises(ValueError, match="smtp_host is required"):
        check_config(cfg(email_provider="smtp", mail_from="a@b.example"))
    with pytest.raises(ValueError, match="sms_provider must be"):
        check_config(cfg(sms_provider="carrier-pigeon"))
    with pytest.raises(ValueError, match="twilio needs"):
        check_config(cfg(sms_provider="twilio"))
    with pytest.raises(ValueError, match="sms_dlt_template_ids"):
        check_config(cfg(sms_dlt_template_ids="[1]"))
